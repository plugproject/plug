import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import type {
  ArchitectureCandidate,
  Candidate,
  Connection,
  ConnectionReport,
  DemoEvent,
  DesignInput,
  DesignRecommendation,
  OperationManifest,
  SystemDescription,
  VerificationRecord,
  WorkspaceIndex,
} from '../../../packages/plug/src/contracts/index';
import {
  parseInput,
  validateInput,
} from '../../../packages/plug/src/contracts/index';
import { importDescription } from '../../../packages/plug/src/importers/index';
import type { WorkflowImport } from '../../../packages/plug/src/openspec/index';
import {
  importWorkflowSpec,
  workflowLimits,
  workflowSpecYaml,
} from '../../../packages/plug/src/openspec/index';
import { Inspector } from './workflow/Inspector';
import { DesignReview } from './workflow/DesignReview';
import type { Focus } from './workflow/model';
import {
  addConnection,
  blankSystem,
  draftGaps,
  reconnect,
  removeElement,
  retarget,
  uniqueId,
} from './workflow/model';
const WorkflowCanvas = lazy(() => import('./workflow/WorkflowCanvas'));
interface SpecStatus {
  present: boolean;
  consistent: boolean;
  workflowEdited: boolean;
  problems: string[];
  summary?: { revisionId: string } | null;
  git?: GitHistory | null;
}
interface SpecRevision {
  id: string;
  at: string;
  source: string;
  changedPaths: string[];
}
interface GitHistory {
  tracked: boolean;
  ignored: boolean;
  commits: { sha: string; at: string; subject: string }[];
}
interface WorkspaceState {
  workspace: string;
  indexed: boolean;
  fresh: boolean | null;
  index: WorkspaceIndex | null;
  spec?: SpecStatus;
}
interface RevisionState {
  revisions: SpecRevision[];
  git: GitHistory | null;
}
const historyLimit = 50;
/** Fields whose own undo applies, and whose consecutive edits are one history step. */
const textEntry = (el: EventTarget | null) =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement &&
    !['checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(
      el.type,
    )) ||
  (el instanceof HTMLElement && el.isContentEditable);
const readable = (s: string) => s.replaceAll('_', ' ').replaceAll('-', ' ');
const num = (v: number | null, unit = '') =>
  v === null ? 'Unknown' : `${Number(v.toFixed(3)).toLocaleString()}${unit}`;
const originOf = (endpoint: string | null | undefined) => {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
};
function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
async function readNdjson(
  response: Response,
  onValue?: (value: Record<string, unknown>) => void,
) {
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      data.error ?? `Request failed with HTTP ${response.status}.`,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let last: Record<string, unknown> = {};
  for (;;) {
    const part = await reader.read();
    pending += decoder.decode(part.value ?? new Uint8Array(), {
      stream: !part.done,
    });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      last = JSON.parse(line);
      onValue?.(last);
      if (last.type === 'error')
        throw new Error(String(last.error ?? 'Request failed.'));
    }
    if (part.done) break;
  }
  return last;
}
function App() {
  const [input, setInput] = useState<DesignInput | null>(null),
    [report, setReport] = useState<DesignRecommendation | null>(null),
    [markdown, setMarkdown] = useState(''),
    [selection, setSelection] = useState(''),
    [stale, setStale] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [json, setJson] = useState(''),
    [importText, setImportText] = useState(''),
    [importKind, setImportKind] = useState<
      'mcp' | 'a2a' | 'openapi' | 'manual'
    >('mcp'),
    [review, setReview] = useState<ReturnType<typeof importDescription> | null>(
      null,
    ),
    [events, setEvents] = useState<DemoEvent[]>([]),
    [demoState, setDemoState] = useState('idle'),
    [changeNote, setChangeNote] = useState(''),
    [active, setActive] = useState(0),
    [workspace, setWorkspace] = useState<WorkspaceState | null>(null),
    [indexing, setIndexing] = useState(false),
    [focus, setFocus] = useState<Focus | null>(null),
    [specReview, setSpecReview] = useState<
      (WorkflowImport & { source: string }) | null
    >(null),
    [specNote, setSpecNote] = useState(''),
    [writingSpec, setWritingSpec] = useState(false),
    [past, setPast] = useState<DesignInput[]>([]),
    [future, setFuture] = useState<DesignInput[]>([]),
    [full, setFull] = useState(false),
    [inspecting, setInspecting] = useState(0),
    [linking, setLinking] = useState(false),
    [canvasNote, setCanvasNote] = useState<{ text: string; n: number } | null>(
      null,
    ),
    [connectionQuery, setConnectionQuery] = useState(''),
    [manifests, setManifests] = useState<OperationManifest[]>([]),
    [authorizedOrigins, setAuthorizedOrigins] = useState<string[]>([]),
    [probing, setProbing] = useState(''),
    [hostDisclosure, setHostDisclosure] = useState<{
      systemId: string;
      name: string;
      /** A host addition is not applied until the author accepts this dialog. */
      next?: DesignInput;
      focus?: Focus;
      active?: number;
    } | null>(null),
    [verification, setVerification] = useState<VerificationRecord | null>(null),
    [verifying, setVerifying] = useState<'as-is' | 'design' | null>(null),
    [revisions, setRevisions] = useState<RevisionState | null>(null);
  const controller = useRef<AbortController | null>(null),
    session = useRef<{ id: string; token: string } | null>(null),
    typing = useRef<EventTarget | null>(null),
    editor = useRef<HTMLDivElement>(null),
    /** The experience a new connection copies once every connection is gone. */
    remembered = useRef<Connection | null>(null);
  useEffect(() => {
    void fetch('/api/examples')
      .then((r) => r.json())
      .then((data) => {
        setInput(data.flight);
        setJson(JSON.stringify(data.flight, null, 2));
      })
      .catch((e) => setError(e.message));
    // Only the local workbench answers this; the hosted playground has no workspace.
    void fetch('/api/workspace')
      .then(async (r) =>
        r.ok && r.headers.get('content-type')?.startsWith('application/json')
          ? setWorkspace(await r.json())
          : null,
      )
      .catch(() => null);
    void fetch('/api/probe')
      .then(async (response) => {
        if (response.ok) {
          const data = await response.json();
          setManifests(data.operations ?? []);
          setAuthorizedOrigins(data.authorizedOrigins ?? []);
        }
      })
      .catch(() => null);
    void fetch('/api/workspace/spec/revisions')
      .then(async (response) => {
        if (response.ok) setRevisions(await response.json());
      })
      .catch(() => null);
    // Typing in a field again after leaving it starts a new history step.
    const leave = () => {
      typing.current = null;
    };
    document.addEventListener('focusin', leave);
    return () => {
      controller.current?.abort();
      document.removeEventListener('focusin', leave);
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (
        !(e.metaKey || e.ctrlKey) ||
        e.altKey ||
        (key !== 'z' && key !== 'y') ||
        textEntry(e.target)
      )
        return;
      e.preventDefault();
      if (key === 'y' || e.shiftKey) redo();
      else undo();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    if (full) {
      // Best effort: the overlay already fills the window when the API is refused.
      if (!document.fullscreenElement)
        editor.current?.requestFullscreen?.().catch(() => undefined);
    } else if (document.fullscreenElement)
      void document.exitFullscreen().catch(() => undefined);
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false);
    };
    const onChange = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onChange);
    document.documentElement.classList.add('wf-locked');
    // The rest of the page sits behind the editor, so it must not take focus.
    const behind: HTMLElement[] = [];
    for (
      let el: HTMLElement | null = editor.current;
      el?.parentElement && el !== document.body;
      el = el.parentElement
    )
      for (const other of el.parentElement.children)
        if (other !== el && other instanceof HTMLElement && !other.inert) {
          other.inert = true;
          behind.push(other);
        }
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onChange);
      document.documentElement.classList.remove('wf-locked');
      for (const el of behind) el.inert = false;
    };
  }, [full]);
  useEffect(() => {
    if (!inspecting) return;
    const frame = requestAnimationFrame(() => {
      const panel = document.getElementById('inspector');
      const target =
        document.getElementById('inspector-experience') ??
        panel?.querySelector<HTMLElement>('input, select');
      const beside = full || !matchMedia('(max-width: 800px)').matches;
      target?.scrollIntoView({ block: beside ? 'nearest' : 'start' });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [inspecting]);
  function show(next: DesignInput) {
    setInput(next);
    setJson(JSON.stringify(next, null, 2));
    setStale(true);
    setError('');
  }
  /** Replaces the input and records the previous one for undo. */
  function replace(next: DesignInput, coalesce = true) {
    if (!input) return show(next);
    const field =
      coalesce && textEntry(document.activeElement)
        ? document.activeElement
        : null;
    if (!field || field !== typing.current)
      setPast((p) => [...p, input].slice(-historyLimit));
    typing.current = field;
    setFuture([]);
    show(next);
  }
  function edit(fn: (next: DesignInput) => void) {
    if (!input) return;
    const next = structuredClone(input);
    try {
      fn(next);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    replace(next);
  }
  function undo() {
    const previous = past.at(-1);
    if (!input || !previous) return;
    setPast(past.slice(0, -1));
    setFuture([input, ...future].slice(0, historyLimit));
    typing.current = null;
    show(previous);
  }
  function redo() {
    const next = future[0];
    if (!input || !next) return;
    setFuture(future.slice(1));
    setPast([...past, input].slice(-historyLimit));
    typing.current = null;
    show(next);
  }
  function inspect(f: Focus) {
    focusOn(f);
    setInspecting((n) => n + 1);
  }
  function selectConnection(i: number, r = report, d = input) {
    setActive(Math.max(0, i));
    const id = d?.connections[i]?.id;
    if (id) setFocus({ kind: 'connection', id });
    const cr = r?.connections.find((x) => x.connectionId === id);
    if (cr) setSelection(cr.selectedId ?? cr.candidates[0].id);
  }
  function focusOn(f: Focus) {
    if (f.kind !== 'connection') return setFocus(f);
    const i = input?.connections.findIndex((c) => c.id === f.id) ?? -1;
    if (i >= 0) selectConnection(i);
  }
  /** New connections copy the active connection's experience, or a placeholder one. */
  function template(d: DesignInput) {
    return (
      d.connections[Math.min(active, d.connections.length - 1)] ??
      remembered.current
    );
  }
  function connect(
    from: { systemId: string; operationId: string },
    to: { systemId: string; operationId: string },
  ) {
    if (!input) return;
    const next = structuredClone(input);
    const id = addConnection(next, from, to, template(input));
    replace(next);
    setActive(input.connections.length);
    setFocus({ kind: 'connection', id });
    const downstream = next.systems.find((system) => system.id === to.systemId);
    const alreadyAuthorized = downstream?.interfaces.some((iface) => {
      const origin = originOf(iface.endpoint);
      return origin !== null && authorizedOrigins.includes(origin);
    });
    if (workspace && alreadyAuthorized)
      void probeSystem(to.systemId, true, false, next, false);
  }
  function rewire(
    connectionId: string,
    from: { systemId: string; operationId: string },
    to: { systemId: string; operationId: string },
  ) {
    if (!input) return;
    const next = structuredClone(input);
    reconnect(next, connectionId, from, to);
    replace(next);
    setActive(
      Math.max(
        0,
        next.connections.findIndex(
          (connection) => connection.id === connectionId,
        ),
      ),
    );
    setFocus({ kind: 'connection', id: connectionId });
    const downstream = next.systems.find((system) => system.id === to.systemId);
    const alreadyAuthorized = downstream?.interfaces.some((iface) => {
      const origin = originOf(iface.endpoint);
      return origin !== null && authorizedOrigins.includes(origin);
    });
    if (workspace && alreadyAuthorized)
      void probeSystem(to.systemId, true, false, next, false);
  }
  /** Removes anything; operations and systems take their connections with them. */
  function remove(f: Focus) {
    if (!input) return;
    const was = template(input);
    if (was) remembered.current = was;
    const system =
      'systemId' in f && input.systems.find((s) => s.id === f.systemId);
    let removed: string[] = [];
    edit((d) => {
      removed = removeElement(d, f);
    });
    const rest = input.connections.filter((c) => !removed.includes(c.id));
    const kept = rest.findIndex(
      (c) =>
        c.id ===
        input.connections[Math.min(active, input.connections.length - 1)]?.id,
    );
    if (f.kind === 'operation') {
      setActive(Math.max(0, kept));
      setFocus({ kind: 'system', systemId: f.systemId });
    } else if (rest.length)
      selectConnection(kept >= 0 ? kept : 0, report, {
        ...input,
        connections: rest,
      });
    else {
      setActive(0);
      setFocus(null);
    }
    const count = (n: number, noun: string) =>
      `${n} ${noun}${n === 1 ? '' : 's'}`;
    const others = removed.filter(
      (id) => f.kind !== 'connection' || id !== f.id,
    );
    const what =
      f.kind === 'connection'
        ? `connection ${f.id}`
        : f.kind === 'operation'
          ? `operation ${f.operationId}`
          : `system ${system ? system.name : f.systemId}${
              system && system.operations.length
                ? ` with ${count(system.operations.length, 'operation')}`
                : ''
            }`;
    setCanvasNote((old) => ({
      n: (old?.n ?? 0) + 1,
      text: `Removed ${what}${
        others.length
          ? `${f.kind === 'system' ? ' and' : ' and its'} ${count(others.length, 'connection')}`
          : ''
      }. Undo restores it.`,
    }));
  }
  function addSystem() {
    if (!input) return;
    const id = uniqueId(
      'system',
      input.systems.map((s) => s.id),
    );
    const next = structuredClone(input);
    next.systems.push(blankSystem(id));
    const nextFocus: Focus = { kind: 'system', systemId: id };
    if (workspace)
      setHostDisclosure({
        systemId: id,
        name: 'New system',
        next,
        focus: nextFocus,
      });
    else {
      replace(next);
      setFocus(nextFocus);
    }
  }
  function addSystemConnected(
    at: { systemId: string; operationId: string },
    as: 'caller' | 'downstream',
  ) {
    if (!input) return;
    const next = structuredClone(input);
    const system = blankSystem(
      uniqueId(
        'system',
        next.systems.map((s) => s.id),
      ),
    );
    next.systems.push(system);
    const mine = {
      systemId: system.id,
      operationId: system.operations[0].id,
    };
    const id = addConnection(
      next,
      as === 'caller' ? mine : at,
      as === 'caller' ? at : mine,
      template(input),
    );
    const nextActive = input.connections.length;
    const nextFocus: Focus = { kind: 'connection', id };
    if (workspace)
      setHostDisclosure({
        systemId: system.id,
        name: 'New system',
        next,
        focus: nextFocus,
        active: nextActive,
      });
    else {
      replace(next);
      setActive(nextActive);
      setFocus(nextFocus);
    }
  }
  async function readSpecFile(file: File) {
    setError('');
    setSpecNote('');
    try {
      if (file.size > workflowLimits.bytes)
        throw new Error('Workflow documents are limited to 64 MB.');
      setSpecReview({
        ...importWorkflowSpec(await file.text()),
        source: file.name,
      });
    } catch (e) {
      setSpecReview(null);
      setError((e as Error).message);
    }
  }
  async function openWorkspaceSpec() {
    setError('');
    try {
      const r = await fetch('/api/workspace/spec');
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      if (typeof data.workflow !== 'string')
        throw new Error('No spec has been written to this workspace yet.');
      setSpecReview({
        ...importWorkflowSpec(data.workflow),
        source: '.plug/workflow.yaml',
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function applySpec() {
    if (!specReview) return;
    const next = specReview.input;
    replace(next, false);
    setSpecReview(null);
    setReview(null);
    selectConnection(0, null, next);
    const count = (n: number, noun: string) =>
      `${n} ${noun}${n === 1 ? '' : 's'}`;
    setSpecNote(
      `Loaded ${count(next.systems.length, 'system')} and ${count(next.connections.length, 'connection')} from ${specReview.source}.`,
    );
  }
  function downloadSpec() {
    if (!input || draftGaps(input).length) return;
    try {
      download(
        'workflow.yaml',
        workflowSpecYaml(input, report && !stale ? report : null),
        'application/yaml',
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function writeSpec() {
    if (!input || draftGaps(input).length) return;
    setWritingSpec(true);
    setError('');
    try {
      const r = await fetch('/api/workspace/spec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setSpecNote(
        `Wrote ${data.files.join(', ')} to ${data.directory}. Your IDE agent can read .plug/AGENTS.md or the Plug MCP server.`,
      );
      const state = await fetch('/api/workspace').then((x) => x.json());
      setWorkspace(state);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWritingSpec(false);
    }
  }
  async function refreshLocalState() {
    const [workspaceResponse, revisionsResponse] = await Promise.all([
      fetch('/api/workspace'),
      fetch('/api/workspace/spec/revisions'),
    ]);
    if (workspaceResponse.ok) setWorkspace(await workspaceResponse.json());
    if (revisionsResponse.ok) setRevisions(await revisionsResponse.json());
  }
  async function probeSystem(
    systemId: string,
    inspectNow: boolean,
    authorize = true,
    source = input,
    recordHistory = true,
  ) {
    if (!source || !workspace) return;
    setProbing(systemId);
    setError('');
    const rememberAuthorization = () => {
      if (!authorize) return;
      const origins = source.systems
        .find((system) => system.id === systemId)
        ?.interfaces.map((iface) => originOf(iface.endpoint))
        .filter((origin): origin is string => origin !== null);
      if (origins?.length)
        setAuthorizedOrigins((current) => [
          ...new Set([...current, ...origins]),
        ]);
    };
    try {
      const response = await fetch('/api/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: source,
          systemId,
          authorize,
          inspect: inspectNow,
        }),
      });
      if (!inspectNow) {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error);
        rememberAuthorization();
        setSpecNote(
          'Host added without inspection. Its exposed endpoints are authorized for an explicit later inspection.',
        );
        return;
      }
      const summary = await readNdjson(response);
      rememberAuthorization();
      const next = summary.input ? validateInput(summary.input) : null;
      if (next) {
        if (recordHistory) replace(next, false);
        else show(next);
      }
      if (Array.isArray(summary.manifests))
        setManifests((current) => {
          const merged = new Map(
            current.map((manifest) => [
              `${manifest.systemId}/${manifest.operationId}`,
              manifest,
            ]),
          );
          for (const manifest of summary.manifests as OperationManifest[])
            merged.set(
              `${manifest.systemId}/${manifest.operationId}`,
              manifest,
            );
          return [...merged.values()];
        });
      setSpecNote(
        'Inspection complete. Measurements are from this local workbench, not production behavior or an SLO.',
      );
      await refreshLocalState();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setProbing('');
      setHostDisclosure(null);
    }
  }
  async function verifyCurrent(mode: 'as-is' | 'design') {
    if (!input || !conn || !workspace) return;
    setVerifying(mode);
    setError('');
    try {
      const response = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input,
          connectionId: conn.id,
          mode,
          revisionId: workspace.spec?.summary?.revisionId,
        }),
      });
      const last = await readNdjson(response);
      if (last.type !== 'verification' || !last.record)
        throw new Error('Verification returned no record.');
      setVerification(last.record as VerificationRecord);
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setVerifying(null);
    }
  }
  async function adoptArchitecture(
    architectureId: string,
    patterns: string[],
    reviewHash?: string,
  ) {
    if (!input || !conn || !workspace) return;
    const response = await fetch('/api/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input,
        connectionId: conn.id,
        architectureId,
        patterns,
        ...(reviewHash ? { reviewHash } : {}),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? 'Adoption failed.');
    setInput(data.input);
    setJson(JSON.stringify(data.input, null, 2));
    setReport(data.design);
    setMarkdown(data.markdown);
    setStale(false);
    setSpecNote(`Adopted ${architectureId} and wrote a new OpenSpec revision.`);
    await refreshLocalState();
  }
  async function clearArchitecture() {
    if (!input || !conn || !workspace) return;
    const response = await fetch('/api/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input,
        connectionId: conn.id,
        clear: true,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(data.error ?? 'Clearing adoption failed.');
    setInput(data.input);
    setJson(JSON.stringify(data.input, null, 2));
    setReport(data.design);
    setMarkdown(data.markdown);
    setStale(false);
    setSpecNote(
      'Cleared the author adoption and restored the engine selection.',
    );
    await refreshLocalState();
  }
  async function openStoredSpec(
    query: { revision?: string; commit?: string },
    source: string,
  ) {
    setError('');
    try {
      const params = new URLSearchParams(query);
      const response = await fetch(`/api/workspace/spec?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSpecReview({
        ...importWorkflowSpec(data.workflow),
        source,
      });
    } catch (problem) {
      setError((problem as Error).message);
    }
  }
  function adoptSystem(
    system: SystemDescription,
    as: 'caller' | 'downstream' | 'add',
  ) {
    if (!input) return;
    const draft = structuredClone(input);
    const i = Math.min(active, draft.connections.length - 1);
    const c = draft.connections[i] as Connection | undefined;
    // Without a connection there is nothing to replace, so the system is added.
    const replacing = !c
      ? null
      : as === 'caller'
        ? c.callerSystemId
        : as === 'downstream'
          ? c.downstreamSystemId
          : null;
    const shared =
      replacing !== null &&
      draft.connections.some(
        (candidate, index) =>
          index !== i &&
          (candidate.callerSystemId === replacing ||
            candidate.downstreamSystemId === replacing),
      );
    const nextSystem = structuredClone(system);
    nextSystem.id = uniqueId(
      nextSystem.id,
      draft.systems
        .filter((candidate) => candidate.id !== replacing || shared)
        .map((candidate) => candidate.id),
    );
    if (replacing === null || shared) draft.systems.push(nextSystem);
    else
      draft.systems[
        draft.systems.findIndex((candidate) => candidate.id === replacing)
      ] = nextSystem;
    if (c && as === 'caller') {
      c.callerSystemId = nextSystem.id;
      c.callerOperationId = nextSystem.operations[0].id;
      c.inputMapping = [];
      c.outputMapping = [];
    } else if (c && as === 'downstream')
      retarget(c, nextSystem.id, nextSystem.operations[0].id);
    if (workspace)
      setHostDisclosure({
        systemId: nextSystem.id,
        name: system.name,
        next: draft,
      });
    else replace(draft);
  }
  async function indexProject() {
    setIndexing(true);
    setError('');
    try {
      const r = await fetch('/api/workspace/index', { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setWorkspace((old) => ({ ...data, spec: old?.spec }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIndexing(false);
    }
  }
  async function analyze() {
    if (!input || draftGaps(input).length) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      const next: DesignRecommendation = data.report;
      const leading = (r: DesignRecommendation) =>
        r.connections
          .map((c) => `${c.connectionId}:${c.selectedArchitectureId}`)
          .join();
      setChangeNote(
        report
          ? leading(report) === leading(next)
            ? 'The leading architecture remains the same. Its comparisons, evidence replay and configuration have been recomputed.'
            : 'Your changes alter the recommended architecture or feasibility.'
          : '',
      );
      setReport(next);
      setMarkdown(data.markdown);
      selectConnection(Math.min(active, next.connections.length - 1), next);
      setStale(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    controller.current?.abort();
    session.current = null;
    setDemoState('idle');
    const data = await fetch('/api/examples').then((r) => r.json());
    replace(data.flight, false);
    setActive(0);
    setReview(null);
    setLinking(false);
  }
  async function run() {
    if (!report || stale) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    session.current = null;
    setEvents([]);
    setDemoState('connecting');
    setError('');
    let terminal = false;
    try {
      const response = await fetch('/api/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          designHash: report.designHash,
          pattern: selection,
        }),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error((await response.json()).error);
      const reader = response.body!.getReader(),
        decoder = new TextDecoder();
      let pending = '';
      setDemoState('running');
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop()!;
        for (const line of lines) {
          if (!line) continue;
          const event: DemoEvent = JSON.parse(line);
          if (event.type === 'session')
            session.current = {
              id: event.sessionId!,
              token: event.actionToken!,
            };
          if (event.type === 'sandbox-termination') {
            terminal = true;
            setDemoState(event.message);
            session.current = null;
          }
          const safe = { ...event };
          delete safe.actionToken;
          setEvents((old) => [...old, safe].slice(-200));
        }
      }
      if (!terminal && !abort.signal.aborted) {
        setDemoState('interrupted');
        session.current = null;
      }
    } catch (e) {
      session.current = null;
      if (abort.signal.aborted) setDemoState('cancelled');
      else {
        setDemoState('interrupted');
        setError((e as Error).message);
      }
    }
  }
  async function action(action: string, key?: string) {
    const s = session.current;
    if (!s) return;
    try {
      const r = await fetch(`/api/demo/${s.id}/actions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Plug-Action-Token': s.token,
        },
        body: JSON.stringify({ action, key }),
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!input)
    return (
      <main>
        <p role="status">{error || 'Loading Plug…'}</p>
      </main>
    );
  const conn = input.connections[
    Math.min(active, input.connections.length - 1)
  ] as Connection | undefined;
  const cr: ConnectionReport | undefined = conn
    ? report?.connections.find((r) => r.connectionId === conn.id)
    : undefined;
  const gaps = draftGaps(input);
  const incomplete = gaps.length
    ? 'Complete the workflow first: ' + gaps.join(' ')
    : undefined;
  const candidate = cr?.candidates.find((c) => c.id === selection),
    running = ['running', 'connecting'].includes(demoState);
  const currentVerification =
    verification &&
    verification.connectionId === conn?.id &&
    verification.designHash === report?.designHash
      ? verification
      : null;
  const systemById = (id: string) => input.systems.find((s) => s.id === id)!;
  const visibleConnections = input.connections
    .map((connection, index) => ({ connection, index }))
    .filter(({ connection }) => {
      const query = connectionQuery.trim().toLowerCase();
      return (
        !query ||
        [
          connection.id,
          systemById(connection.callerSystemId).name,
          systemById(connection.downstreamSystemId).name,
        ]
          .join(' ')
          .toLowerCase()
          .includes(query)
      );
    });
  const designGroups = input.systems
    .map((system) => ({
      system,
      connections: input.connections
        .map((connection, index) => ({ connection, index }))
        .filter(({ connection }) => connection.callerSystemId === system.id),
    }))
    .filter((group) => group.connections.length > 0);
  const exists = (f: Focus | null): f is Focus =>
    !!f &&
    (f.kind === 'connection'
      ? input.connections.some((c) => c.id === f.id)
      : input.systems.some(
          (s) =>
            s.id === f.systemId &&
            (f.kind === 'system' ||
              s.operations.some((o) => o.id === f.operationId)),
        ));
  const current: Focus | null = exists(focus)
    ? focus
    : conn
      ? { kind: 'connection', id: conn.id }
      : null;
  const focusLabel = !current
    ? null
    : current.kind === 'connection'
      ? current.id
      : current.kind === 'operation'
        ? current.operationId
        : systemById(current.systemId).name;
  const outcomes =
    report && !stale
      ? Object.fromEntries(
          report.connections.map((r) => [
            r.connectionId,
            r.selectedArchitectureId
              ? { label: r.selectedArchitectureId, status: 'feasible' }
              : { label: 'no feasible design', status: 'infeasible' },
          ]),
        )
      : null;
  return (
    <>
      <header>
        <a className="brand" href="#">
          plug<span className="brand-dot">.</span>
        </a>
        <span className="env">
          {workspace ? 'local workbench' : 'public alpha'} · 0.2
        </span>
        <nav aria-label="Page">
          {workspace && <a href="#workspace">Workspace</a>}
          <a href="#workflow">Workflow</a>
          <a href="#designs">Designs</a>
          <a href="#try">Try</a>
        </nav>
      </header>
      {hostDisclosure && (
        <div className="modal-backdrop">
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="host-disclosure-title"
          >
            <h2 id="host-disclosure-title">Add integration host?</h2>
            <p>
              Adding <strong>{hostDisclosure.name}</strong> authorizes Plug to
              inspect everything it exposes. Automatic calls are limited to
              protocol-safe reads; write operations are never automatically
              probed.
            </p>
            <p className="small">
              Measurements describe this local workbench vantage, not production
              behavior or an SLO. Cache permission remains author-declared.
            </p>
            <div className="modal-actions">
              <button
                className="dark"
                disabled={!!probing}
                onClick={() => {
                  const pending = hostDisclosure;
                  if (pending.next) {
                    replace(pending.next, false);
                    if (pending.focus) setFocus(pending.focus);
                    if (pending.active !== undefined) setActive(pending.active);
                  }
                  void probeSystem(
                    pending.systemId,
                    true,
                    true,
                    pending.next ?? input,
                    !pending.next,
                  );
                }}
              >
                {probing ? 'Inspecting…' : 'Add and inspect'}
              </button>
              <button
                disabled={!!probing}
                onClick={() => {
                  const pending = hostDisclosure;
                  if (pending.next) {
                    replace(pending.next, false);
                    if (pending.focus) setFocus(pending.focus);
                    if (pending.active !== undefined) setActive(pending.active);
                  }
                  void probeSystem(
                    pending.systemId,
                    false,
                    true,
                    pending.next ?? input,
                    !pending.next,
                  );
                }}
              >
                Add without inspecting
              </button>
            </div>
          </section>
        </div>
      )}
      <main>
        <section className="intro">
          <div>
            <h1>Design workbench</h1>
            <p>
              Describe systems and the experience each connection must meet.
              Plug derives relation facts, evaluates six seed designs and
              composes architectures ranked by your priorities, each with its
              proof. Analysis is deterministic; only explicit local inspection
              and verification call authorized read endpoints.
            </p>
          </div>
          <button className="text-button" onClick={() => void reset()}>
            ↺ Restore flight example
          </button>
        </section>
        {workspace && (
          <section id="workspace" className="panel workspace-panel">
            <div className="section-heading">
              <span className="step">00</span>
              <div>
                <h2>This project</h2>
                <p>
                  Index {workspace.workspace} locally to draft its interfaces
                  and list the facts Plug still needs.
                </p>
              </div>
              <span className="tag">Local only · no network</span>
            </div>
            {!workspace.indexed || !workspace.index ? (
              <div className="empty-state">
                This project is not indexed yet.
                <small>
                  Indexing reads OpenAPI documents, Agent Cards, package
                  manifests and source markers. Secrets, dependencies and
                  symbolic links are skipped.
                </small>
                <button
                  className="dark"
                  disabled={indexing}
                  onClick={() => void indexProject()}
                >
                  {indexing ? 'Indexing…' : 'Index this project'}
                </button>
              </div>
            ) : (
              <WorkspaceSummary
                state={workspace}
                indexing={indexing}
                onReindex={() => void indexProject()}
                onAdopt={(as) => adoptSystem(workspace.index!.system!, as)}
                canAdd
              />
            )}
          </section>
        )}
        <section id="workflow" className="panel">
          <div className="section-heading">
            <span className="step">01</span>
            <div>
              <h2>Workflow</h2>
              <p>
                Systems are groups and their operations are nodes. Each edge is
                one connection with its own required experience and priorities.
              </p>
              <details className="help">
                <summary>Editing the canvas</summary>
                <p>
                  Double-click empty canvas to add a system, or inside a system
                  to add an operation; right-click anything for its actions.
                  Hover an operation and drag the + on either edge to an
                  operation of another system to connect them, or click the + to
                  pick one; drop on empty canvas to add a connected system. Add
                  connection lets you click the caller, then the operation it
                  calls. Drag an operation onto another system to move it there,
                  or onto empty canvas to give it a system of its own. Drag a
                  system anywhere to arrange the canvas; it stays where you put
                  it through later edits until ↺ Re-layout. × removes anything,
                  with the connections it takes part in; undo brings it back.
                  Enter a system&apos;s server or OpenAPI document in the
                  inspector to list its tools, skills or operations.
                </p>
              </details>
            </div>
            <span className="tag">Analysis only · no credentials</span>
          </div>
          <div
            ref={editor}
            className={full ? 'workflow-editor wf-full' : 'workflow-editor'}
            role={full ? 'dialog' : undefined}
            aria-modal={full ? true : undefined}
            aria-label={full ? 'Workflow editor' : undefined}
          >
            <div className="workflow-toolbar">
              <button onClick={addSystem}>+ Add system</button>
              <button
                className="mode-button"
                aria-pressed={linking}
                title={
                  'Click the calling operation, then the operation it calls; Esc cancels'
                }
                onClick={() => setLinking(!linking)}
              >
                + Add connection
              </button>
              <button
                className="icon-button"
                aria-label="Undo"
                title="Undo (Ctrl+Z or ⌘Z)"
                disabled={!past.length}
                onClick={undo}
              >
                ↶
              </button>
              <button
                className="icon-button"
                aria-label="Redo"
                title="Redo (Shift+Ctrl+Z or Shift+⌘Z)"
                disabled={!future.length}
                onClick={redo}
              >
                ↷
              </button>
              <span className="small">
                {input.systems.length} systems · {input.connections.length}{' '}
                {input.connections.length === 1 ? 'connection' : 'connections'}
              </span>
              <span className="toolbar-spacer" />
              <label className="button file-button">
                ↑ Upload OpenSpec
                <input
                  type="file"
                  accept=".yaml,.yml,.json"
                  aria-label="Upload OpenSpec workflow"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void readSpecFile(file);
                  }}
                />
              </label>
              <button
                disabled={!!incomplete}
                title={incomplete}
                onClick={downloadSpec}
              >
                ↓ Download OpenSpec
              </button>
              {workspace && (
                <>
                  {workspace.spec?.present && (
                    <button onClick={() => void openWorkspaceSpec()}>
                      Open workspace spec
                    </button>
                  )}
                  <button
                    className="dark"
                    disabled={writingSpec || !!incomplete}
                    title={incomplete}
                    onClick={() => void writeSpec()}
                  >
                    {writingSpec ? 'Writing…' : 'Write spec to workspace'}
                  </button>
                </>
              )}
            </div>
            {full && error && (
              <div role="alert" className="notice error">
                {error}
              </div>
            )}
            {gaps.length > 0 && (
              <div className="notice draft-gaps" role="status">
                <strong>Draft in progress.</strong> Plug analyzes and exports
                the workflow once it is complete:
                <ul>
                  {gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </div>
            )}
            {workspace?.spec?.workflowEdited && (
              <p className="notice" role="status">
                .plug/workflow.yaml changed since Plug last wrote it, for
                example by your IDE agent. Open the workspace spec to review it
                here, then write the spec to re-analyze and record it.
              </p>
            )}
            {workspace && revisions && (
              <details className="spec-history">
                <summary>Spec history</summary>
                {revisions.git?.ignored && (
                  <p className="notice">
                    .plug/workflow.yaml is ignored by Git. Plug still keeps up
                    to 50 local revisions; it never stages or commits files.
                  </p>
                )}
                <h3>Plug revisions</h3>
                {revisions.revisions.length ? (
                  <ul>
                    {revisions.revisions.map((revision) => (
                      <li key={revision.id}>
                        <button
                          className="text-button"
                          onClick={() =>
                            void openStoredSpec(
                              { revision: revision.id },
                              `Plug revision ${revision.id.slice(0, 12)}`,
                            )
                          }
                        >
                          {revision.id.slice(0, 12)}
                        </button>{' '}
                        {revision.source} ·{' '}
                        {new Date(revision.at).toLocaleString()}
                        {revision.changedPaths.length > 0 && (
                          <small>
                            {revision.changedPaths.slice(0, 4).join(', ')}
                          </small>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="small">No retained revision yet.</p>
                )}
                {revisions.git?.commits.length ? (
                  <>
                    <h3>Git history</h3>
                    <ul>
                      {revisions.git.commits.map((commit) => (
                        <li key={commit.sha}>
                          <button
                            className="text-button"
                            onClick={() =>
                              void openStoredSpec(
                                { commit: commit.sha },
                                `Git ${commit.sha.slice(0, 12)}`,
                              )
                            }
                          >
                            {commit.sha.slice(0, 12)}
                          </button>{' '}
                          {commit.subject}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <p className="small">
                  Opening a revision enters the review region below. Choose
                  Replace workflow, then Write spec to workspace to restore it.
                </p>
              </details>
            )}
            {specNote && (
              <p className="notice" role="status">
                {specNote}
              </p>
            )}
            {specReview && (
              <div
                className="import-review spec-review"
                role="region"
                aria-label="Workflow import review"
              >
                <h3>Review {specReview.source}</h3>
                <p>
                  {specReview.input.systems.length} systems ·{' '}
                  {specReview.input.connections.length} connections ·{' '}
                  {specReview.lossless
                    ? 'Plug export, restored exactly'
                    : 'Drafted from the workflow; unknown facts stay unknown'}
                </p>
                {specReview.gaps.length > 0 && (
                  <ul aria-label="Import gaps">
                    {specReview.gaps.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                )}
                <button className="dark" onClick={applySpec}>
                  Replace workflow
                </button>
                <button
                  className="text-button"
                  onClick={() => setSpecReview(null)}
                >
                  Discard
                </button>
              </div>
            )}
            {input.connections.length > 12 && (
              <label className="connection-search">
                Find a connection
                <input
                  type="search"
                  value={connectionQuery}
                  onChange={(event) => setConnectionQuery(event.target.value)}
                  placeholder="Connection or system name"
                />
              </label>
            )}
            <div
              className="connection-tabs"
              role="tablist"
              aria-label="Connections"
            >
              {visibleConnections.map(({ connection: c, index: i }) => (
                <button
                  key={c.id}
                  role="tab"
                  aria-selected={c.id === conn?.id}
                  className={
                    c.id === conn?.id ? 'candidate active' : 'candidate'
                  }
                  onClick={() => selectConnection(i)}
                >
                  <strong>{c.id}</strong>
                  <small>
                    {systemById(c.callerSystemId).name} →{' '}
                    {systemById(c.downstreamSystemId).name}
                  </small>
                </button>
              ))}
            </div>
            <div className="workflow-layout">
              <div className="wf-stage">
                <Suspense
                  fallback={
                    <div className="wf-canvas wf-loading" role="status">
                      Loading workflow…
                    </div>
                  }
                >
                  <WorkflowCanvas
                    input={input}
                    focus={current}
                    outcomes={outcomes}
                    fullscreen={full}
                    linking={linking}
                    onLinkingChange={setLinking}
                    note={canvasNote}
                    onFocus={focusOn}
                    onInspect={inspect}
                    onConnect={connect}
                    onReconnect={rewire}
                    onDelete={remove}
                    onSpawn={addSystemConnected}
                    onAddSystem={addSystem}
                    onToggleFullscreen={() => setFull(!full)}
                    onEdit={edit}
                  />
                </Suspense>
                {focusLabel && (
                  <button
                    className="wf-inspect-chip"
                    onClick={() =>
                      document
                        .getElementById('inspector')
                        ?.scrollIntoView({ block: 'start' })
                    }
                  >
                    Edit {focusLabel} ↓
                  </button>
                )}
              </div>
              <Inspector
                input={input}
                focus={current}
                local={!!workspace}
                edit={edit}
                onFocus={focusOn}
                onRemove={remove}
                onHostAdded={(systemId, name) =>
                  setHostDisclosure({ systemId, name })
                }
              />
            </div>
            {workspace && (
              <section className="manifest-panel" aria-label="Probe manifest">
                <div className="section-heading compact">
                  <div>
                    <h3>Integration manifest</h3>
                    <p>
                      Authorized local-workbench observations, never production
                      measurements or SLOs.
                    </p>
                  </div>
                </div>
                {manifests.length === 0 ? (
                  <p className="small">
                    No operation has been inspected from this workbench yet.
                  </p>
                ) : (
                  <div className="manifest-grid">
                    {manifests.map((manifest) => {
                      const related = input.connections.filter(
                        (connection) =>
                          connection.downstreamSystemId === manifest.systemId &&
                          connection.downstreamOperationId ===
                            manifest.operationId,
                      );
                      const conflict = related.some((connection) =>
                        [
                          connection.profile.latencyMs,
                          connection.profile.responseBytes,
                          connection.profile.availability,
                        ].some(
                          (fact) =>
                            fact?.evidence.kind === 'probed' &&
                            fact.evidence.note.includes('Previous value:') &&
                            !fact.evidence.note.includes('"kind":"unknown"'),
                        ),
                      );
                      return (
                        <article key={manifest.manifestHash}>
                          <strong>
                            {manifest.systemId} / {manifest.operationId}
                          </strong>
                          {conflict && (
                            <span className="tag conflict">
                              prior fact replaced
                            </span>
                          )}
                          <small>
                            {manifest.vantage.kind} · {manifest.sampleSize}{' '}
                            samples · {manifest.windowMs} ms window
                          </small>
                          <small>
                            p95 {manifest.latencyMs.p95 ?? 'unknown'} ms ·
                            availability{' '}
                            {manifest.availability === null
                              ? 'unknown'
                              : `${(manifest.availability * 100).toFixed(1)}%`}
                          </small>
                          <button
                            disabled={!!probing}
                            onClick={() =>
                              void probeSystem(manifest.systemId, true, false)
                            }
                          >
                            {probing === manifest.systemId
                              ? 'Inspecting…'
                              : 'Re-inspect'}
                          </button>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            )}
          </div>
          <details>
            <summary>Import MCP / A2A / OpenAPI metadata</summary>
            <p className="small">
              Paste or upload metadata for review; nothing here contacts a
              server or calls a tool. MCP needs a wrapper with serverId,
              protocolVersion, and response (or ordered pages). A2A 1.0 Agent
              Cards import skills; contracts remain gaps. OpenAPI documents
              import operations with their inline schemas.{' '}
              {workspace
                ? 'To list a running server instead, select a system and enter its server details in the inspector.'
                : 'Listing a running server needs the local workbench (npx plug ui).'}
            </p>
            <div className="fields">
              <label>
                Document kind
                <select
                  value={importKind}
                  onChange={(e) => {
                    setImportKind(e.target.value as typeof importKind);
                    setReview(null);
                  }}
                >
                  <option value="mcp">MCP tools/list</option>
                  <option value="a2a">A2A Agent Card</option>
                  <option value="openapi">OpenAPI document</option>
                  <option value="manual">Plug system description</option>
                </select>
              </label>
              <label>
                Upload document
                <input
                  type="file"
                  accept=".json,.yaml,.yml"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const maximum = workspace ? workflowLimits.bytes : 262144;
                    if (file.size > maximum) {
                      setError(
                        `Description exceeds ${workspace ? '64 MB' : '256 KB'}`,
                      );
                      return;
                    }
                    setImportText(await file.text());
                    setReview(null);
                  }}
                />
              </label>
            </div>
            <label>
              Pasted metadata
              <textarea
                value={importText}
                onChange={(e) => {
                  setImportText(e.target.value);
                  setReview(null);
                }}
                placeholder={
                  '{"serverId":"my-server","protocolVersion":"2025-11-25","response":{"tools":[]}}'
                }
              />
            </label>
            <button
              onClick={() => {
                try {
                  setReview(importDescription(importText, importKind));
                  setError('');
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Review extracted facts
            </button>
            {review && (
              <div className="import-review">
                <h3>{review.system.name}</h3>
                <p>
                  Metadata{' '}
                  {review.metadataUnderstood ? 'understood' : 'needs review'} ·
                  Execution unsupported here
                </p>
                <ul>
                  {review.gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
                <pre>{JSON.stringify(review.system, null, 2)}</pre>
                <button
                  onClick={() => adoptSystem(review.system, 'downstream')}
                >
                  Use as downstream system
                </button>
                <button onClick={() => adoptSystem(review.system, 'add')}>
                  Add as another system
                </button>
              </div>
            )}
          </details>
          <details>
            <summary>
              Advanced input · JSON / YAML, mappings and evidence
            </summary>
            <p className="small">
              Edit any contract, operational fact, key dimension or mapping.
              Explicit null values preserve unknowns. This document is not
              persisted.
            </p>
            <label>
              Design input
              <textarea
                className="json-editor"
                value={json}
                onChange={(e) => setJson(e.target.value)}
                spellCheck={false}
              />
            </label>
            <button
              onClick={() => {
                try {
                  const next = validateInput(parseInput(json));
                  replace(next, false);
                  selectConnection(0, null, next);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Apply document
            </button>
          </details>
          <div className="analyze-row">
            <p>
              Declared estimates are welcome.
              <br />
              Missing evidence stays visible.
            </p>
            <button
              className="dark"
              disabled={busy || !!incomplete}
              title={incomplete}
              onClick={() => void analyze()}
            >
              {busy ? 'Evaluating…' : 'Suggest design'}{' '}
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </section>
        {!full && error && (
          <div role="alert" className="notice error">
            {error}
          </div>
        )}
        <section id="designs" className="panel">
          <div className="section-heading">
            <span className="step">02</span>
            <div>
              <h2>Suggested designs</h2>
              <p>Compare the direct baseline with introduced architecture.</p>
            </div>
          </div>
          {stale && report && (
            <p role="status" className="notice">
              Inputs changed. Click Suggest design to recompute before exporting
              or running.
            </p>
          )}
          {!report || !cr ? (
            <div className="empty-state">
              Your requirements become the comparison.
              <small>
                Six seed designs, a pattern knowledge base and bounded
                compositions. No hidden provider switching.
              </small>
            </div>
          ) : (
            <>
              {changeNote && <p className="notice">{changeNote}</p>}
              {report.connections.length > 1 && (
                <div
                  className={
                    report.connections.length > 12
                      ? 'design-groups'
                      : 'connection-tabs'
                  }
                  role="group"
                  aria-label="Connection results"
                >
                  {report.connections.length > 12
                    ? designGroups.map((group) => (
                        <details key={group.system.id} open>
                          <summary>
                            {group.system.name} · {group.connections.length}
                          </summary>
                          <div className="connection-tabs">
                            {group.connections.map(({ connection, index }) => {
                              const result = report.connections.find(
                                (candidate) =>
                                  candidate.connectionId === connection.id,
                              )!;
                              return (
                                <button
                                  key={result.connectionId}
                                  className={
                                    result.connectionId === cr.connectionId
                                      ? 'candidate active'
                                      : 'candidate'
                                  }
                                  onClick={() => selectConnection(index)}
                                >
                                  <strong>{result.connectionId}</strong>
                                  <small>
                                    {result.selectedArchitectureId ??
                                      'No feasible design'}
                                  </small>
                                </button>
                              );
                            })}
                          </div>
                        </details>
                      ))
                    : report.connections.map((result, index) => (
                        <button
                          key={result.connectionId}
                          className={
                            result.connectionId === cr.connectionId
                              ? 'candidate active'
                              : 'candidate'
                          }
                          onClick={() => selectConnection(index)}
                        >
                          <strong>{result.connectionId}</strong>
                          <small>
                            {result.selectedArchitectureId ??
                              'No feasible design'}
                          </small>
                        </button>
                      ))}
                </div>
              )}
              <div className="verdict-comparison">
                <article>
                  <span className="tag">Engine verdict</span>
                  <strong>
                    {cr.candidates.find((item) => item.id === 'direct')
                      ?.status === 'feasible_under_declared_assumptions'
                      ? 'Achievable as-is'
                      : cr.selectedArchitectureId
                        ? 'Needs a design'
                        : 'Not established'}
                  </strong>
                  <small>
                    Deterministic evaluation of declared and probed facts.
                  </small>
                </article>
                <article>
                  <span className="tag">Demonstration</span>
                  <strong>
                    {currentVerification
                      ? readable(currentVerification.verdict)
                      : 'Not run'}
                  </strong>
                  <small>
                    Workbench vantage only; this is not a production SLO.
                  </small>
                </article>
              </div>
              {workspace && (
                <div className="demo-toolbar verify-toolbar">
                  <button
                    disabled={!!verifying || stale}
                    onClick={() => void verifyCurrent('as-is')}
                  >
                    {verifying === 'as-is' ? 'Verifying…' : 'Verify as-is'}
                  </button>
                  <button
                    className="dark"
                    disabled={
                      !!verifying || stale || !cr.selectedArchitectureId
                    }
                    onClick={() => void verifyCurrent('design')}
                  >
                    {verifying === 'design'
                      ? 'Verifying…'
                      : 'Verify selected design'}
                  </button>
                </div>
              )}
              <p className="outcome">
                {cr.selectedId
                  ? 'A design meets the stated requirements under its assumptions.'
                  : 'No feasible candidate under the supplied facts and supported catalog.'}
              </p>
              {cr.policyDecisionNeeded && (
                <p role="status" className="notice">
                  Several non-dominated architectures tie on your priorities.
                  This is a policy decision: reorder priorities or choose one
                  explicitly.
                </p>
              )}
              <Frontier
                report={cr}
                local={!!workspace}
                onAdopt={(architectureId, patterns) =>
                  void adoptArchitecture(architectureId, patterns).catch(
                    (problem) => setError((problem as Error).message),
                  )
                }
                onClear={() =>
                  void clearArchitecture().catch((problem) =>
                    setError((problem as Error).message),
                  )
                }
              />
              {workspace && (
                <DesignReview
                  input={input}
                  design={report}
                  report={cr}
                  revisionId={workspace.spec?.summary?.revisionId ?? null}
                  onAdopt={(architectureId, patterns, reviewHash) =>
                    adoptArchitecture(architectureId, patterns, reviewHash)
                  }
                />
              )}
              {report.crossConnection.length > 0 && (
                <div className="cross-connection">
                  <h3>Cross-connection checks</h3>
                  <ul className="criteria">
                    {report.crossConnection.map((r) => (
                      <li key={r.id}>
                        <span className={`verdict ${r.verdict}`}>
                          {r.verdict === 'fail'
                            ? '×'
                            : r.verdict === 'unknown'
                              ? '?'
                              : '✓'}
                        </span>
                        <div>
                          <strong>
                            {readable(r.id)} · {readable(r.verdict)}
                          </strong>
                          <p>{r.reason}</p>
                          <small>
                            Compared {r.actual ?? 'unknown'} with{' '}
                            {r.required ?? 'unspecified'}.
                          </small>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <h3>Seed designs</h3>
              <div className="design-grid">
                <div
                  className="candidate-list"
                  role="group"
                  aria-label="Architecture alternatives"
                >
                  {cr.candidates.map((c) => (
                    <button
                      key={c.id}
                      className={
                        selection === c.id ? 'candidate active' : 'candidate'
                      }
                      onClick={() => setSelection(c.id)}
                    >
                      <strong>{c.title}</strong>
                      <span className={`status ${c.status}`}>
                        {readable(c.status)}
                      </span>
                      <small>
                        {num(c.estimates.usefulLatencyMs, ' ms')} estimated
                        useful response
                      </small>
                    </button>
                  ))}
                </div>
                {candidate && <Design candidate={candidate} />}
              </div>
              <div className="downloads">
                <button
                  disabled={stale}
                  onClick={() =>
                    download('design.json', JSON.stringify(report, null, 2))
                  }
                >
                  ↓ Design JSON
                </button>
                <button
                  disabled={stale}
                  onClick={() =>
                    download('design.md', markdown, 'text/markdown')
                  }
                >
                  ↓ Implementation recipe
                </button>
                <button
                  disabled={stale}
                  onClick={() =>
                    download(
                      'runner.json',
                      JSON.stringify(
                        {
                          designHash: report.designHash,
                          inputHash: report.inputHash,
                          catalogHash: report.catalogHash,
                          connectionId: cr.connectionId,
                          config: candidate?.config,
                        },
                        null,
                        2,
                      ),
                    )
                  }
                >
                  ↓ Runner config
                </button>
              </div>
              <details>
                <summary>Missing information and provenance</summary>
                <p>
                  Cost ranking{' '}
                  {cr.costRankingAvailable
                    ? 'available'
                    : 'unavailable: missing cost is not zero; fall back to complexity and stable pattern ID.'}
                </p>
                <ul>
                  {report.missingInformation.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
                <p className="hash">
                  Input {report.inputHash}
                  <br />
                  Design {report.designHash}
                  <br />
                  Catalog {report.catalogVersion}
                </p>
              </details>
            </>
          )}
        </section>
        <section id="try" className="panel">
          <div className="section-heading">
            <span className="step">03</span>
            <div>
              <h2>Try design</h2>
              <p>
                An isolated, real HTTP proof. Source latency stays 15 seconds.
              </p>
            </div>
            <span className="tag">120-second sandbox</span>
          </div>
          <p className="small">
            The bundled fixture starts empty. Setup is visible and separate from
            request timing. Measured cache time excludes the estimated
            agent/model overhead. Own descriptions are analysis-only here; use
            the local CLI for your trusted HTTP service.
          </p>
          <div className="demo-toolbar">
            <button
              className="dark"
              disabled={!candidate?.executableHere || stale || running}
              onClick={() => void run()}
            >
              Start {candidate?.id ?? 'selected design'}
            </button>
            <button
              disabled={!running}
              onClick={() => {
                setDemoState('cancelled');
                session.current = null;
                controller.current?.abort();
              }}
            >
              Cancel
            </button>
            <span role="status">{readable(demoState)}</span>
          </div>
          <div className="demo-actions">
            <button
              disabled={!session.current || !running}
              onClick={() => void action('request', 'hot0')}
            >
              Request DEL → LHR
            </button>
            <button
              disabled={!session.current || !running}
              onClick={() => void action('request', 'hot1')}
            >
              Request BOM → SIN
            </button>
            <button
              disabled={!session.current || !running}
              onClick={() => void action('request', 'cold')}
            >
              Unprewarmed query
            </button>
            <button
              disabled={!session.current || !running}
              onClick={() => void action('expire')}
            >
              Expire cache
            </button>
            <button
              disabled={!session.current || !running}
              onClick={() => void action('fail-next-refresh')}
            >
              Fail next refresh
            </button>
            <button
              disabled={!session.current || !running}
              onClick={() => void action('change-data')}
            >
              Change source data
            </button>
          </div>
          <div
            className="event-log"
            role="log"
            aria-label="Sandbox events"
            aria-live="polite"
          >
            {events.length === 0 ? (
              <p>Ready when you are. No pre-seeded responses.</p>
            ) : (
              events.map((e, i) => (
                <article
                  key={i}
                  className={
                    e.type === 'target-miss' || e.type === 'refresh-failure'
                      ? 'event warning'
                      : 'event'
                  }
                >
                  <time>{new Date(e.atMs).toLocaleTimeString()}</time>
                  <div>
                    <strong>{readable(e.type)}</strong>
                    <p>{e.message}</p>
                    {e.durationMs !== undefined && (
                      <span>Measured path: {num(e.durationMs, ' ms')} · </span>
                    )}
                    {e.dataAgeMs !== undefined && (
                      <span>Source age: {num(e.dataAgeMs, ' ms')}</span>
                    )}
                    {e.data && <pre>{JSON.stringify(e.data, null, 2)}</pre>}
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
        <footer>
          <span className="brand">plug.</span>
          <span className="env">0.2.0-alpha.1</span>
          <span className="footer-spacer" />
          <a
            href="https://github.com/plugproject/plug/issues"
            target="_blank"
            rel="noreferrer"
          >
            Feedback ↗
          </a>
          <a
            href="https://github.com/plugproject/plug/blob/main/docs/docs/quickstart.mdx"
            target="_blank"
            rel="noreferrer"
          >
            Local quickstart ↗
          </a>
        </footer>
      </main>
    </>
  );
}
const tri = (v: boolean | null) => (v === null ? 'unknown' : v ? 'yes' : 'no');
function Frontier({
  report,
  local,
  onAdopt,
  onClear,
}: {
  report: ConnectionReport;
  local: boolean;
  onAdopt: (architectureId: string, patterns: string[]) => void;
  onClear: () => void;
}) {
  const shown = report.architectures.filter(
    (a) => a.status !== 'infeasible' || a.patterns.length === 1,
  );
  const notable = report.patterns.filter((p) =>
    [
      'required',
      'supported',
      'unknown',
      'contraindicated',
      'needs_global_context',
    ].includes(p.applicability),
  );
  return (
    <div className="frontier">
      <h3>Architecture frontier</h3>
      <p className="small">
        Compositions of seed designs and patterns that close every detected
        problem and obligation. Dominated architectures stay visible with the
        architecture that beats them.
      </p>
      {report.adoption && (
        <p
          className={`notice adoption-${report.adoption.status}`}
          role="status"
        >
          Author adoption: <strong>{readable(report.adoption.status)}</strong>.{' '}
          {report.adoption.reason}{' '}
          {local && (
            <button className="text-button" onClick={onClear}>
              Clear adoption
            </button>
          )}
        </p>
      )}
      <ol aria-label="Architecture frontier">
        {shown.map((a) => (
          <ArchitectureRow
            key={a.id}
            a={a}
            engineSelected={a.id === report.selectedArchitectureId}
            adopted={a.id === report.adoptedArchitectureId}
            canAdopt={
              local &&
              a.frontier &&
              a.status === 'feasible_under_declared_assumptions'
            }
            onAdopt={() => onAdopt(a.id, a.patterns)}
          />
        ))}
      </ol>
      <details>
        <summary>Relation facts</summary>
        <ul className="relation-facts">
          {Object.entries(report.relation).map(([k, f]) => (
            <li key={k}>
              <strong>
                {k}: {tri(f.value)}
              </strong>{' '}
              {f.reason}
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Pattern applicability</summary>
        <ul className="relation-facts">
          {notable.map((p) => (
            <li key={p.id}>
              <strong>
                {p.id}: {readable(p.applicability)}
              </strong>{' '}
              {p.reason}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
function ArchitectureRow({
  a,
  engineSelected,
  adopted,
  canAdopt,
  onAdopt,
}: {
  a: ArchitectureCandidate;
  engineSelected: boolean;
  adopted: boolean;
  canAdopt: boolean;
  onAdopt: () => void;
}) {
  return (
    <li
      className={
        engineSelected || adopted
          ? 'architecture-row selected'
          : 'architecture-row'
      }
    >
      <div>
        <strong>{a.patterns.join(' + ')}</strong>
        <span className={`status ${a.status}`}>{readable(a.status)}</span>
        <small>
          {adopted
            ? 'Author adopted'
            : engineSelected
              ? 'Engine selected'
              : a.frontier
                ? 'On the frontier'
                : a.dominatedBy
                  ? `Dominated by ${a.dominatedBy}`
                  : ''}
        </small>
        {canAdopt && !adopted && (
          <button className="text-button" onClick={onAdopt}>
            Adopt
          </button>
        )}
      </div>
      <details>
        <summary>Proof</summary>
        {a.proof.because.length > 0 && (
          <>
            <h4>Because</h4>
            <ul>
              {a.proof.because.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </>
        )}
        {a.proof.unknowns.length > 0 && (
          <>
            <h4>Unknowns</h4>
            <ul>
              {a.proof.unknowns.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </>
        )}
        {a.proof.rejectedAlternatives.length > 0 && (
          <>
            <h4>Rejected</h4>
            <ul>
              {a.proof.rejectedAlternatives.map((r) => (
                <li key={r.id}>
                  {r.id}: {r.reason}
                </li>
              ))}
            </ul>
          </>
        )}
        {a.tasks.length > 0 && (
          <>
            <h4>Tasks</h4>
            <ol>
              {a.tasks.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ol>
          </>
        )}
      </details>
    </li>
  );
}
function WorkspaceSummary({
  state,
  indexing,
  onReindex,
  onAdopt,
  canAdd,
}: {
  state: WorkspaceState;
  indexing: boolean;
  onReindex: () => void;
  onAdopt: (as: 'caller' | 'downstream' | 'add') => void;
  canAdd: boolean;
}) {
  const index = state.index!;
  const counts = new Map<string, number>();
  for (const f of index.findings)
    counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return (
    <div className="workspace-summary">
      <p role="status" className={state.fresh === false ? 'notice' : 'small'}>
        {state.fresh === false
          ? 'The project changed since it was indexed. Re-index before relying on the draft.'
          : `Indexed ${new Date(index.scannedAt).toLocaleString()} · ${index.filesScanned} files${index.truncated ? ' · bounded scan, incomplete' : ''}`}
      </p>
      <ul className="finding-counts">
        {[...counts].map(([kind, n]) => (
          <li key={kind}>
            <strong>{n}</strong> {readable(kind)}
          </li>
        ))}
      </ul>
      {index.system ? (
        <>
          <p className="small">
            Draft system <strong>{index.system.name}</strong> with{' '}
            {index.system.operations.map((o) => o.id).join(', ')}. Static facts
            only; review before use.
          </p>
          <div className="demo-toolbar">
            <button onClick={() => onAdopt('caller')}>
              Use draft as caller
            </button>
            <button onClick={() => onAdopt('downstream')}>
              Use draft as downstream
            </button>
            <button disabled={!canAdd} onClick={() => onAdopt('add')}>
              Add draft as another system
            </button>
            <button
              className="text-button"
              disabled={indexing}
              onClick={onReindex}
            >
              {indexing ? 'Indexing…' : '↻ Re-index'}
            </button>
          </div>
        </>
      ) : (
        <button disabled={indexing} onClick={onReindex}>
          {indexing ? 'Indexing…' : '↻ Re-index'}
        </button>
      )}
      <details>
        <summary>Facts Plug still needs ({index.gaps.length})</summary>
        <ul>
          {index.gaps.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Findings and their sources</summary>
        <ul className="relation-facts">
          {index.findings.map((f, i) => (
            <li key={i}>
              <strong>
                {readable(f.kind)} · {f.name}
              </strong>{' '}
              {f.detail} <small>{f.evidence.source?.location}</small>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
function Design({ candidate: c }: { candidate: Candidate }) {
  const isCache = !['direct', 'progressive'].includes(c.id);
  const flow = (label: string, nodes: [string, string][]) => (
    <div className="architecture-path">
      <small>{label}</small>
      <div>
        {nodes.map(([name, kind], i) => (
          <React.Fragment key={name}>
            {i > 0 && <b aria-hidden="true">→</b>}
            <span className={kind === 'introduced' ? 'introduced' : ''}>
              {name}
              <small>{kind}</small>
            </span>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
  return (
    <article className="design-detail">
      <div className="card-label">
        {c.components.length ? 'PROPOSED ARCHITECTURE' : 'EXISTING CONNECTION'}
        <span>{c.components.length} introduced components</span>
      </div>
      <h3>{c.title}</h3>
      <div className="architecture" aria-label="Request and maintenance paths">
        {isCache ? (
          <>
            {flow('REQUEST', [
              ['Caller', 'existing'],
              ['Exact-key cache', 'introduced'],
              ['Options + age', 'result'],
            ])}
            {c.id.startsWith('scheduled') &&
              flow('MAINTENANCE', [
                ['Scheduler', 'introduced'],
                ['Slow source', 'existing'],
                ['Exact-key cache', 'introduced'],
              ])}
            {flow(
              c.id === 'cached-live' ? 'LATER LIVE UPDATE' : 'MISS / EXPIRY',
              [
                ['Caller', 'existing'],
                ['Slow source', 'existing'],
                ['Live result', 'result'],
              ],
            )}
            <p>
              Commitment still requires live revalidation. Slow misses can miss
              the target.
            </p>
          </>
        ) : c.id === 'progressive' ? (
          <>
            {flow('INITIAL', [
              ['Caller', 'existing'],
              ['Useful initial output', 'result'],
            ])}
            {flow('DEFERRED', [
              ['Caller', 'existing'],
              ['Source', 'existing'],
              ['Later live result', 'result'],
            ])}
          </>
        ) : (
          flow('DIRECT REQUEST', [
            ['Caller', 'existing'],
            ['Source', 'existing'],
            ['Useful output', 'result'],
          ])
        )}
      </div>
      <div className="metrics">
        <div>
          <strong>{num(c.estimates.usefulLatencyMs, ' ms')}</strong>
          <small>Useful-path estimate</small>
        </div>
        <div>
          <strong>
            {num(
              c.config.refreshIntervalMs === null
                ? null
                : c.config.refreshIntervalMs / 1000,
              ' s',
            )}
          </strong>
          <small>Refresh interval</small>
        </div>
        <div>
          <strong>
            {num(
              c.estimates.trafficSuccessRate === null
                ? null
                : c.estimates.trafficSuccessRate * 100,
              '%',
            )}
          </strong>
          <small>Synthetic target success</small>
        </div>
      </div>
      <p className="small">
        Metadata {c.metadataUnderstood ? 'understood' : 'needs review'} · Design
        evaluated ·{' '}
        {c.executableHere
          ? 'Executable with bundled fixture'
          : 'Execution unsupported here'}
      </p>
      <ul className="criteria">
        {c.criteria.map((r) => (
          <li key={r.id}>
            <span className={`verdict ${r.verdict}`}>
              {r.verdict === 'fail' ? '×' : r.verdict === 'unknown' ? '?' : '✓'}
            </span>
            <div>
              <strong>
                {readable(r.id)} · {readable(r.verdict)}
              </strong>
              <p>{r.reason}</p>
              <small>
                {r.actual !== null
                  ? `Compared ${r.actual} with ${r.required ?? 'requirement'}. `
                  : ''}
                Evidence: {r.evidence.map((e) => e.kind).join(', ')}
              </small>
            </div>
          </li>
        ))}
      </ul>
      <details>
        <summary>Implementation tasks, assumptions and tradeoffs</summary>
        <ol>
          {c.tasks.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ol>
        <ul>
          {[...c.assumptions, ...c.tradeoffs].map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Exact configuration and estimates</summary>
        <pre>
          {JSON.stringify(
            { config: c.config, estimates: c.estimates },
            null,
            2,
          )}
        </pre>
      </details>
    </article>
  );
}
export default App;
