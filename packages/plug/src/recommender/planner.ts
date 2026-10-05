import type {
  Applicability,
  ArchitectureCandidate,
  Candidate,
  CandidateStatus,
  Condition,
  ObligationStatus,
  PatternDefinition,
  PatternEvaluation,
  Priority,
  RelationFacts,
  TradeoffVector,
} from '../contracts/index';
import { knowledge, obligations, problems } from '../patterns/knowledge';
import { cached, scheduled } from '../patterns/catalog';
export const maxAddedPatterns = 6;
const maxStacksPerBase = 12;
const rank: Record<CandidateStatus, number> = {
  feasible_under_declared_assumptions: 0,
  conditional: 1,
  insufficient_information: 2,
  infeasible: 3,
};
const worst = (a: CandidateStatus, b: CandidateStatus) =>
  rank[a] >= rank[b] ? a : b;
const holds = (relation: RelationFacts, c: Condition) => {
  const v = relation[c.fact].value;
  return v === null ? null : v === c.is;
};
const describe = (c: Condition) => `${c.fact} is ${c.is}`;
export function evaluatePatterns(
  relation: RelationFacts,
  candidates: Candidate[],
  firstResponseBudgetMs: number | null,
): PatternEvaluation[] {
  const viable = candidates.filter((c) => c.status !== 'infeasible');
  const present = problems.filter(
    (p) => holds(relation, { fact: p.fact, is: p.is }) === true,
  );
  const solversOf = (problem: string) =>
    knowledge.filter((k) => k.template === null && k.solves.includes(problem));
  const base = knowledge.map((p) => evaluateOne(p, relation));
  const usable = new Set(
    base
      .filter((e) => ['supported', 'unknown'].includes(e.applicability))
      .map((e) => e.id),
  );
  return base.map((e) => {
    const p = knowledge.find((k) => k.id === e.id)!;
    if (p.template !== null) {
      const c = candidates.find((x) => x.id === p.template)!;
      const applicability: Applicability =
        c.status === 'feasible_under_declared_assumptions'
          ? 'supported'
          : c.status === 'infeasible'
            ? 'contraindicated'
            : 'unknown';
      return {
        ...e,
        applicability,
        reason:
          c.status === 'infeasible'
            ? `Seed design fails: ${c.criteria.find((r) => r.verdict === 'fail')?.reason ?? 'infeasible'}`
            : `Seed design evaluated ${c.status.replaceAll('_', ' ')}.`,
      };
    }
    if (e.applicability !== 'supported') return e;
    const solved = present.filter((pr) => p.solves.includes(pr.id));
    if (!solved.length)
      return {
        ...e,
        applicability: 'optional' as Applicability,
        reason: p.solves.length
          ? `Available to discharge ${p.solves.join(', ')} if a selected pattern introduces it.`
          : `Optional companion of ${p.composesWith.join(', ') || 'other patterns'}.`,
      };
    const sole = solved.filter(
      (pr) =>
        !viable.some((c) => baseSolves(c, pr.id, firstResponseBudgetMs)) &&
        solversOf(pr.id).filter((s) => usable.has(s.id)).length === 1,
    );
    return sole.length
      ? {
          ...e,
          applicability: 'required' as Applicability,
          reason: `Only supported solver of ${sole.map((s) => s.id).join(', ')}.`,
        }
      : {
          ...e,
          reason: `Solves ${solved.map((s) => s.id).join(', ')}.`,
        };
  });
}
function evaluateOne(
  p: PatternDefinition,
  relation: RelationFacts,
): PatternEvaluation {
  const facts = [
    ...new Set(
      [...p.preconditions, ...p.contraindications, ...p.requiresOneOf].map(
        (c) => c.fact,
      ),
    ),
  ];
  if (p.scope === 'global')
    return {
      id: p.id,
      applicability: 'needs_global_context',
      reason: 'Requires context beyond one pair of systems.',
      facts,
    };
  if (p.template !== null)
    return {
      id: p.id,
      applicability: 'supported',
      reason: 'Seed design; see its evaluated candidate.',
      facts,
    };
  const contra = p.contraindications.filter((c) => holds(relation, c) === true);
  if (contra.length)
    return {
      id: p.id,
      applicability: 'contraindicated',
      reason: `Contraindicated: ${contra.map((c) => `${describe(c)} (${relation[c.fact].reason})`).join('; ')}`,
      facts,
    };
  const unmet = p.preconditions.filter((c) => holds(relation, c) === false);
  if (unmet.length)
    return {
      id: p.id,
      applicability: 'not_applicable',
      reason: `Precondition not met: ${unmet.map((c) => `${describe(c)} (${relation[c.fact].reason})`).join('; ')}`,
      facts,
    };
  if (
    p.requiresOneOf.length &&
    p.requiresOneOf.every((c) => holds(relation, c) === false)
  )
    return {
      id: p.id,
      applicability: 'contraindicated',
      reason: `Requires one of ${p.requiresOneOf.map(describe).join(', ')}; none holds.`,
      facts,
    };
  const unknown = [
    ...p.preconditions,
    ...p.contraindications,
    ...(p.requiresOneOf.some((c) => holds(relation, c) === true)
      ? []
      : p.requiresOneOf),
  ].filter((c) => holds(relation, c) === null);
  if (unknown.length)
    return {
      id: p.id,
      applicability: 'unknown',
      reason: `Unknown: ${[...new Set(unknown.map((c) => relation[c.fact].reason))].join(' ')}`,
      facts,
    };
  return { id: p.id, applicability: 'supported', reason: '', facts };
}
interface Stack {
  patterns: string[];
  open: string[];
  problemSolvers: Map<string, string | null>;
  obligations: ObligationStatus[];
}
/** Problems a seed base addresses structurally, independent of the relation predicate. */
function baseSolves(base: Candidate, problem: string, budget: number | null) {
  const quota = base.criteria.find((c) => c.id === 'quota')?.verdict;
  if (problem === 'capacity_overload')
    return cached(base.id) && quota === 'pass_under_assumptions';
  if (problem === 'burst_overload')
    return scheduled(base.id) && quota === 'pass_under_assumptions';
  if (problem === 'first_response_gap')
    return (
      budget !== null &&
      base.estimates.usefulLatencyMs !== null &&
      base.estimates.usefulLatencyMs <= budget
    );
  return false;
}
function closeStacks(
  base: Candidate,
  open: string[],
  relation: RelationFacts,
  usable: Set<string>,
): Stack[] {
  const results: Stack[] = [];
  const problemIds = new Set(problems.map((p) => p.id));
  const expand = (s: Stack) => {
    if (results.length >= maxStacksPerBase) return;
    if (!s.open.length) {
      results.push(s);
      return;
    }
    const [item, ...rest] = s.open;
    const isProblem = problemIds.has(item) && s.problemSolvers.has(item);
    const record = (solver: string | null, next: Stack) => {
      if (isProblem) next.problemSolvers.set(item, solver);
      else
        next.obligations.push({
          id: item,
          coveredBy: solver,
          dischargedBy: null,
        });
    };
    const existing = s.patterns.find((id) =>
      knowledge.find((k) => k.id === id)!.solves.includes(item),
    );
    if (existing) {
      const next = clone(s, rest);
      record(existing, next);
      expand(next);
      return;
    }
    const solvers = knowledge.filter(
      (k) =>
        k.template === null &&
        k.solves.includes(item) &&
        usable.has(k.id) &&
        !k.conflicts.some((c) => s.patterns.includes(c)) &&
        !s.patterns.some((id) =>
          knowledge.find((x) => x.id === id)!.conflicts.includes(k.id),
        ),
    );
    if (!solvers.length || s.patterns.length >= maxAddedPatterns) {
      const next = clone(s, rest);
      record(null, next);
      expand(next);
      return;
    }
    for (const solver of solvers) {
      const next = clone(s, rest);
      next.patterns.push(solver.id);
      record(solver.id, next);
      for (const ob of solver.introduces) {
        if (next.open.includes(ob) || next.obligations.some((o) => o.id === ob))
          continue;
        const solvedProblem = next.problemSolvers.get(ob);
        if (solvedProblem) {
          next.obligations.push({
            id: ob,
            coveredBy: solvedProblem,
            dischargedBy: null,
          });
          continue;
        }
        const def = obligations.find((o) => o.id === ob)!;
        const discharge = def.dischargedBy.find(
          (c) => holds(relation, c) === true,
        );
        if (discharge)
          next.obligations.push({
            id: ob,
            coveredBy: null,
            dischargedBy: discharge.fact,
          });
        else next.open.push(ob);
      }
      expand(next);
    }
  };
  expand({
    patterns: [],
    open,
    problemSolvers: new Map(open.map((p) => [p, null])),
    obligations: [],
  });
  return results;
}
const clone = (s: Stack, open: string[]): Stack => ({
  patterns: [...s.patterns],
  open: [...open],
  problemSolvers: new Map(s.problemSolvers),
  obligations: s.obligations.map((o) => ({ ...o })),
});
function tradeoffs(base: Candidate, patterns: string[]): TradeoffVector {
  const defs = [base.id, ...patterns].map((id) =>
    knowledge.find((k) => k.id === id)!,
  );
  const components = new Set(defs.flatMap((d) => d.components));
  return {
    usefulLatencyMs: base.estimates.usefulLatencyMs,
    trafficSuccessRate: base.estimates.trafficSuccessRate,
    costPerMinute: base.estimates.costPerMinute,
    consistencyWeakening: Math.max(
      ...defs.map((d) => d.tradeoffs.consistencyWeakening),
    ),
    runtimeCoupling: Math.min(
      ...defs
        .map((d) => d.tradeoffs.runtimeCoupling)
        .filter((v): v is NonNullable<typeof v> => v !== null),
    ),
    operationalComplexity: defs.reduce(
      (a, d) => a + d.tradeoffs.operationalComplexity,
      0,
    ),
    statefulness: defs.reduce((a, d) => a + d.tradeoffs.statefulness, 0),
    componentCount: components.size,
  };
}
type Dim = { key: keyof TradeoffVector; better: 'min' | 'max' };
const dims: Dim[] = [
  { key: 'usefulLatencyMs', better: 'min' },
  { key: 'trafficSuccessRate', better: 'max' },
  { key: 'costPerMinute', better: 'min' },
  { key: 'consistencyWeakening', better: 'min' },
  { key: 'runtimeCoupling', better: 'min' },
  { key: 'operationalComplexity', better: 'min' },
  { key: 'statefulness', better: 'min' },
  { key: 'componentCount', better: 'min' },
];
const priorityDims: Record<Priority, Dim[]> = {
  correctness: [{ key: 'consistencyWeakening', better: 'min' }],
  latency: [
    { key: 'usefulLatencyMs', better: 'min' },
    { key: 'trafficSuccessRate', better: 'max' },
  ],
  availability: [{ key: 'runtimeCoupling', better: 'min' }],
  simplicity: [
    { key: 'componentCount', better: 'min' },
    { key: 'operationalComplexity', better: 'min' },
    { key: 'statefulness', better: 'min' },
  ],
  cost: [{ key: 'costPerMinute', better: 'min' }],
};
/** Negative when a is better; zero when tied or incomparable on this dimension. */
const compareDim = (a: TradeoffVector, b: TradeoffVector, d: Dim) => {
  const x = a[d.key],
    y = b[d.key];
  if (x === null || y === null) return 0;
  return d.better === 'min' ? x - y : y - x;
};
/** A dominates B only when every dimension is known for both (or unknown for both) and A is no worse anywhere, strictly better somewhere. */
export function dominates(a: TradeoffVector, b: TradeoffVector) {
  let strict = false;
  for (const d of dims) {
    const x = a[d.key],
      y = b[d.key];
    if (x === null && y === null) continue;
    if (x === null || y === null) return false;
    const c = compareDim(a, b, d);
    if (c > 0) return false;
    if (c < 0) strict = true;
  }
  return strict;
}
export function comparePriorities(
  a: TradeoffVector,
  b: TradeoffVector,
  priorities: Priority[],
) {
  for (const p of priorities)
    for (const d of priorityDims[p]) {
      const c = compareDim(a, b, d);
      if (c !== 0) return c;
    }
  return 0;
}
export function planArchitectures(
  candidates: Candidate[],
  relation: RelationFacts,
  priorities: Priority[],
  firstResponseBudgetMs: number | null,
) {
  const patterns = evaluatePatterns(
    relation,
    candidates,
    firstResponseBudgetMs,
  );
  const usable = new Set(
    patterns
      .filter((e) =>
        ['required', 'supported', 'optional', 'unknown'].includes(
          e.applicability,
        ),
      )
      .map((e) => e.id),
  );
  const applicability = new Map(patterns.map((e) => [e.id, e]));
  const present = problems.filter(
    (p) => holds(relation, { fact: p.fact, is: p.is }) === true,
  );
  const unknownProblems = problems.filter(
    (p) => holds(relation, { fact: p.fact, is: p.is }) === null,
  );
  const architectures: ArchitectureCandidate[] = [];
  for (const base of candidates) {
    const rejectedBases = candidates
      .filter((c) => c.id !== base.id && c.status === 'infeasible')
      .map((c) => ({
        id: c.id,
        reason:
          c.criteria.find((r) => r.verdict === 'fail')?.reason ??
          'Infeasible under the supplied facts.',
      }));
    const baseUnknowns = base.criteria
      .filter((r) => r.verdict === 'unknown')
      .map((r) => `${r.id}: ${r.reason}`);
    if (base.status === 'infeasible') {
      architectures.push(
        architecture(base, [], 'infeasible', {
          problems: [],
          obligations: [],
          because: base.criteria
            .filter((r) => r.verdict === 'fail')
            .map(
              (r) =>
                `${r.id} fails: ${r.reason} Compared ${r.actual ?? 'unknown'} with ${r.required ?? 'unspecified'}.`,
            ),
          rejected: rejectedBases,
          unknowns: baseUnknowns,
        }),
      );
      continue;
    }
    const open = present
      .filter((p) => !baseSolves(base, p.id, firstResponseBudgetMs))
      .map((p) => p.id);
    const stillUnknown = unknownProblems.filter(
      (p) => !baseSolves(base, p.id, firstResponseBudgetMs),
    );
    for (const stack of closeStacks(base, open, relation, usable)) {
      const unresolvedProblems = [...stack.problemSolvers].filter(
        ([, s]) => s === null,
      );
      const openObligations = stack.obligations.filter(
        (o) => o.coveredBy === null && o.dischargedBy === null,
      );
      const unknownPatterns = stack.patterns.filter(
        (id) => applicability.get(id)?.applicability === 'unknown',
      );
      let status: CandidateStatus = base.status;
      if (unresolvedProblems.length) status = 'infeasible';
      if (
        openObligations.length ||
        unknownPatterns.length ||
        stillUnknown.length
      )
        status = worst(status, 'conditional');
      const solvedHere = present.map((p) => ({
        id: p.id,
        solvedBy: baseSolves(base, p.id, firstResponseBudgetMs)
          ? base.id
          : (stack.problemSolvers.get(p.id) ?? null),
      }));
      const rejectedSolvers = [...open, ...stack.obligations.map((o) => o.id)]
        .flatMap((item) =>
          knowledge.filter(
            (k) =>
              k.template === null &&
              k.solves.includes(item) &&
              !usable.has(k.id),
          ),
        )
        .map((k) => ({ id: k.id, reason: applicability.get(k.id)!.reason }));
      architectures.push(
        architecture(base, stack.patterns, status, {
          problems: solvedHere,
          obligations: stack.obligations,
          because: [
            ...solvedHere.map((p) => {
              const def = problems.find((d) => d.id === p.id)!;
              return `${def.description}: ${relation[def.fact].reason} ${p.solvedBy ? `Addressed by ${p.solvedBy}.` : 'No supported pattern addresses it.'}`;
            }),
            ...stack.obligations
              .filter((o) => o.coveredBy || o.dischargedBy)
              .map((o) =>
                o.coveredBy
                  ? `Obligation ${o.id} covered by ${o.coveredBy}.`
                  : `Obligation ${o.id} discharged: ${relation[o.dischargedBy!].reason}`,
              ),
            ...base.criteria
              .filter((r) => r.verdict === 'pass_under_assumptions')
              .map(
                (r) =>
                  `${r.id} passes under assumptions (${r.actual ?? '-'} vs ${r.required ?? '-'}).`,
              ),
          ],
          rejected: [
            ...rejectedBases,
            ...rejectedSolvers.filter(
              (r, i, all) => all.findIndex((x) => x.id === r.id) === i,
            ),
          ],
          unknowns: [
            ...baseUnknowns,
            ...stillUnknown.map(
              (p) => `${p.description}? ${relation[p.fact].reason}`,
            ),
            ...unknownPatterns.map(
              (id) => `${id}: ${applicability.get(id)!.reason}`,
            ),
            ...openObligations.map(
              (o) =>
                `Open obligation ${o.id}: ${obligations.find((d) => d.id === o.id)!.description}.`,
            ),
          ],
        }),
      );
    }
  }
  for (const tier of Object.keys(rank) as CandidateStatus[]) {
    if (tier === 'infeasible') continue;
    const members = architectures.filter((a) => a.status === tier);
    for (const a of members) {
      const by = members.find(
        (b) => b !== a && dominates(b.tradeoffs, a.tradeoffs),
      );
      a.frontier = !by;
      a.dominatedBy = by?.id ?? null;
    }
  }
  architectures.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      Number(b.frontier) - Number(a.frontier) ||
      comparePriorities(a.tradeoffs, b.tradeoffs, priorities) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const feasibleFrontier = architectures.filter(
    (a) => a.frontier && a.status === 'feasible_under_declared_assumptions',
  );
  return {
    patterns,
    architectures,
    selectedArchitectureId: feasibleFrontier[0]?.id ?? null,
    policyDecisionNeeded:
      feasibleFrontier.length > 1 &&
      comparePriorities(
        feasibleFrontier[0].tradeoffs,
        feasibleFrontier[1].tradeoffs,
        priorities,
      ) === 0,
    unknownProblems: unknownProblems.map(
      (p) => `${p.description}? ${relation[p.fact].reason}`,
    ),
  };
}
function architecture(
  base: Candidate,
  patterns: string[],
  status: CandidateStatus,
  detail: {
    problems: { id: string; solvedBy: string | null }[];
    obligations: ObligationStatus[];
    because: string[];
    rejected: { id: string; reason: string }[];
    unknowns: string[];
  },
): ArchitectureCandidate {
  const defs = patterns.map((id) => knowledge.find((k) => k.id === id)!);
  const components = [
    ...new Set([...base.components, ...defs.flatMap((d) => d.components)]),
  ];
  return {
    id: [base.id, ...patterns].join('+'),
    base: base.id,
    patterns: [base.id, ...patterns],
    status,
    frontier: false,
    dominatedBy: null,
    problems: detail.problems,
    obligations: detail.obligations,
    tradeoffs: tradeoffs(base, patterns),
    proof: {
      because: detail.because,
      rejectedAlternatives: detail.rejected,
      unknowns: [...new Set(detail.unknowns)],
    },
    components,
    diagram:
      base.diagram +
      defs
        .map((d, i) => `\n  A -.- P${i}["Introduced ${d.title.toLowerCase()}"]`)
        .join(''),
    tasks: [...base.tasks, ...defs.flatMap((d) => d.tasks)],
    executableHere: base.executableHere && !patterns.length,
  };
}
