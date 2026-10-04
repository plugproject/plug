import React, { useEffect, useRef, useState } from 'react';
import type {
  Candidate,
  DemoEvent,
  DesignInput,
  DesignRecommendation,
  Fact,
} from '../../../packages/plug/src/contracts/index';
import {
  parseInput,
  validateInput,
} from '../../../packages/plug/src/contracts/index';
import { importDescription } from '../../../packages/plug/src/importers/index';
const readable = (s: string) => s.replaceAll('_', ' ').replaceAll('-', ' ');
const num = (v: number | null, unit = '') =>
  v === null ? 'Unknown' : `${Number(v.toFixed(3)).toLocaleString()}${unit}`;
const declared = (value: number | null): Fact => ({
  value,
  evidence: {
    kind: value === null ? 'unknown' : 'declared',
    note: 'Entered by the author in the playground.',
  },
});
function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
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
    [importKind, setImportKind] = useState<'mcp' | 'a2a' | 'manual'>('mcp'),
    [review, setReview] = useState<ReturnType<typeof importDescription> | null>(
      null,
    ),
    [events, setEvents] = useState<DemoEvent[]>([]),
    [demoState, setDemoState] = useState('idle'),
    [changeNote, setChangeNote] = useState('');
  const controller = useRef<AbortController | null>(null),
    session = useRef<{ id: string; token: string } | null>(null);
  useEffect(() => {
    void fetch('/api/examples')
      .then((r) => r.json())
      .then((data) => {
        setInput(data.flight);
        setJson(JSON.stringify(data.flight, null, 2));
      })
      .catch((e) => setError(e.message));
    return () => controller.current?.abort();
  }, []);
  function edit(fn: (next: DesignInput) => void) {
    if (!input) return;
    const next = structuredClone(input);
    fn(next);
    setInput(next);
    setJson(JSON.stringify(next, null, 2));
    setStale(true);
    setError('');
  }
  async function analyze() {
    if (!input) return;
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
      setChangeNote(
        report
          ? report.selectedId === data.report.selectedId
            ? 'The leading architecture remains the same. Its comparisons, evidence replay and configuration have been recomputed.'
            : 'Your changes alter the recommended architecture or feasibility.'
          : '',
      );
      setReport(data.report);
      setMarkdown(data.markdown);
      setSelection(data.report.selectedId ?? data.report.candidates[0].id);
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
    setInput(data.flight);
    setJson(JSON.stringify(data.flight, null, 2));
    setStale(true);
    setReview(null);
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
  const candidate = report?.candidates.find((c) => c.id === selection),
    running = ['running', 'connecting'].includes(demoState);
  if (!input)
    return (
      <main>
        <p role="status">{error || 'Loading Plug…'}</p>
      </main>
    );
  const factField = (
    label: string,
    value: number | null,
    onChange: (n: number | null) => void,
    step = 1,
  ) => (
    <label>
      {label}
      <input
        type="number"
        min="0"
        step={step}
        value={value ?? ''}
        placeholder="Unknown"
        onChange={(e) =>
          onChange(e.target.value === '' ? null : Number(e.target.value))
        }
      />
    </label>
  );
  return (
    <>
      <header>
        <a className="brand" href="#">
          plug<span className="brand-dot">.</span>
        </a>
        <nav aria-label="Page">
          <a href="#systems">Systems</a>
          <a href="#experience">Experience</a>
          <a href="#designs">Designs</a>
          <a href="#try">Try it</a>
        </nav>
        <span className="version">PUBLIC ALPHA · 0.1</span>
      </header>
      <main>
        <section className="hero">
          <div>
            <div className="eyebrow">
              <span /> TWO SYSTEMS. A BETTER CONNECTION.
            </div>
            <h1>
              Design for the
              <br />
              <em>experience.</em>
            </h1>
            <p>
              Describe what your systems can do and what your users need. Find
              the architecture that closes the gap—with the evidence to explain
              it.
            </p>
            <a className="button dark" href="#systems">
              Explore a design <span>↗</span>
            </a>
          </div>
          <div
            className="hero-visual"
            aria-label="Slow source connected through a cache to a fast experience"
          >
            <div className="visual-caption">
              THE FLIGHT SEARCH EXAMPLE <span>01 / 01</span>
            </div>
            <div className="source-node">
              <span className="node-icon">↗</span>
              <div>
                Flight aggregator<small>Real HTTP source</small>
              </div>
              <strong>15s</strong>
            </div>
            <div className="connector">
              <span>↓</span> Move work before the request
            </div>
            <div className="cache-node">
              <span className="node-icon">▦</span>
              <div>
                Refresh + exact-key cache<small>Introduced by Plug</small>
              </div>
              <span className="plus">+</span>
            </div>
            <div className="connector">
              <span>↓</span> Serve eligible indicative options
            </div>
            <div className="result-node">
              <span>Useful response target</span>
              <strong>&lt; 2s</strong>
            </div>
            <p>
              Same slow source. Different architecture.
              <br />
              Freshness and coverage decide whether it works.
            </p>
          </div>
        </section>
        <div className="workspace-heading">
          <span>YOUR DESIGN WORKSPACE</span>
          <button className="text-button" onClick={() => void reset()}>
            ↺ Restore flight example
          </button>
        </div>
        <section id="systems" className="panel">
          <div className="section-heading">
            <span className="step">01</span>
            <div>
              <h2>Systems</h2>
              <p>
                Start with two systems and the operation that connects them.
              </p>
            </div>
            <span className="tag">Analysis only · no credentials</span>
          </div>
          <div className="system-grid">
            {input.systems.map((system, i) => (
              <article className="system-card" key={i}>
                <div className="card-label">
                  SYSTEM {i === 0 ? 'A' : 'B'}{' '}
                  <span>{i === 0 ? 'CALLER' : 'DOWNSTREAM'}</span>
                </div>
                <label>
                  System name
                  <input
                    value={system.name}
                    onChange={(e) =>
                      edit((d) => {
                        d.systems[i].name = e.target.value;
                      })
                    }
                  />
                </label>
                <div className="fields">
                  <label>
                    Protocol
                    <select
                      value={system.interfaces[0].protocol}
                      onChange={(e) =>
                        edit((d) => {
                          d.systems[i].interfaces[0].protocol = e.target
                            .value as 'http';
                        })
                      }
                    >
                      <option value="http">HTTP</option>
                      <option value="mcp">MCP</option>
                      <option value="a2a">A2A</option>
                    </select>
                  </label>
                  <label>
                    Direction
                    <select
                      value={system.interfaces[0].direction}
                      onChange={(e) =>
                        edit((d) => {
                          d.systems[i].interfaces[0].direction = e.target
                            .value as 'calls';
                        })
                      }
                    >
                      <option value="calls">Can call</option>
                      <option value="exposes">Exposes</option>
                    </select>
                  </label>
                </div>
                <label>
                  Selected operation
                  <select
                    value={
                      i === 0
                        ? input.connection.callerOperationId
                        : input.connection.downstreamOperationId
                    }
                    onChange={(e) =>
                      edit((d) => {
                        if (i === 0)
                          d.connection.callerOperationId = e.target.value;
                        else {
                          d.connection.downstreamOperationId = e.target.value;
                          d.profile.operationId = e.target.value;
                        }
                      })
                    }
                  >
                    {system.operations.map((op) => (
                      <option key={op.id}>{op.id}</option>
                    ))}
                  </select>
                </label>
                <p className="small">{system.operations[0].description}</p>
              </article>
            ))}
          </div>
          <div className="fields profile-fields">
            {factField(
              'Source latency (ms)',
              input.profile.latencyMs.value,
              (n) =>
                edit((d) => {
                  d.profile.latencyMs = declared(n);
                }),
            )}
            {factField(
              'Hard timeout (ms)',
              input.profile.timeoutMs.value,
              (n) =>
                edit((d) => {
                  d.profile.timeoutMs = declared(n);
                }),
            )}
            {factField(
              'Typical change interval (ms)',
              input.profile.changeIntervalMs.value,
              (n) =>
                edit((d) => {
                  d.profile.changeIntervalMs = declared(n);
                }),
            )}
            {factField(
              'Upstream calls / minute',
              input.profile.callsPerMinute.value,
              (n) =>
                edit((d) => {
                  d.profile.callsPerMinute = declared(n);
                }),
            )}
            {factField(
              'Hot-key coverage ceiling (0–1)',
              input.workload.hotKeyShare.value,
              (n) =>
                edit((d) => {
                  d.workload.hotKeyShare = declared(n);
                }),
              0.01,
            )}
            <label>
              Source cache permission
              <select
                value={String(
                  input.systems[1].operations[0].semantics.cachePermission,
                )}
                onChange={(e) =>
                  edit((d) => {
                    d.systems[1].operations[0].semantics.cachePermission =
                      e.target.value === 'null'
                        ? null
                        : e.target.value === 'true';
                  })
                }
              >
                <option value="true">Allowed</option>
                <option value="false">Disallowed</option>
                <option value="null">Unknown</option>
              </select>
            </label>
          </div>
          <details>
            <summary>Import MCP / A2A metadata</summary>
            <p className="small">
              Paste or upload metadata for review. No discovery requests or tool
              calls. MCP needs a wrapper with serverId, protocolVersion, and
              response (or ordered pages). A2A 1.0 Agent Cards import skills;
              contracts remain gaps.
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
                    if (file.size > 262144) {
                      setError('Description exceeds 256 KB');
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
                  onClick={() => {
                    edit((d) => {
                      d.systems[1] = review.system;
                      d.connection.downstreamSystemId = review.system.id;
                      d.connection.downstreamOperationId =
                        review.system.operations[0].id;
                      d.connection.inputMapping = [];
                      d.connection.outputMapping = [];
                      d.connection.adapter = null;
                      d.profile = {
                        ...d.profile,
                        systemId: review.system.id,
                        operationId: review.system.operations[0].id,
                        latencyMs: declared(null),
                        timeoutMs: declared(null),
                        callsPerMinute: declared(null),
                        concurrency: declared(null),
                        responseBytes: declared(null),
                        callCost: declared(null),
                        changeIntervalMs: declared(null),
                        sourceLagMs: declared(null),
                        sourceTimestamp: 'unknown',
                        invalidation: 'unknown',
                      };
                      d.workload.trace = null;
                      d.workload.prewarmKeys = null;
                      d.workload.hotKeyShare = declared(null);
                    });
                  }}
                >
                  Use as downstream system
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
                  setInput(next);
                  setStale(true);
                  setError('');
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Apply document
            </button>
          </details>
        </section>
        <section id="experience" className="panel">
          <div className="section-heading">
            <span className="step">02</span>
            <div>
              <h2>Required experience</h2>
              <p>Set the outcome. Plug proposes the components.</p>
            </div>
          </div>
          <div className="fields">
            <label>
              Useful initial output
              <input
                value={input.experience.usefulOutput}
                onChange={(e) =>
                  edit((d) => {
                    d.experience.usefulOutput = e.target.value;
                  })
                }
              />
            </label>
            {factField(
              'Latency target (ms)',
              input.experience.latencyTargetMs,
              (n) =>
                edit((d) => {
                  d.experience.latencyTargetMs = n ?? 0;
                }),
            )}
            {factField(
              'Maximum result age (ms)',
              input.experience.maxAgeMs,
              (n) =>
                edit((d) => {
                  d.experience.maxAgeMs = n;
                }),
            )}
            <label>
              Correctness
              <select
                value={input.experience.correctness}
                onChange={(e) =>
                  edit((d) => {
                    d.experience.correctness = e.target.value as 'live';
                    d.experience.allowIndicative =
                      e.target.value === 'indicative';
                  })
                }
              >
                <option value="indicative">
                  Indicative options are useful
                </option>
                <option value="live">Live source result required</option>
              </select>
            </label>
            <label>
              Latency scope
              <select
                value={input.experience.scope}
                onChange={(e) =>
                  edit((d) => {
                    d.experience.scope = e.target.value as 'warmHits';
                  })
                }
              >
                <option value="trafficPercentile">
                  Stated traffic percentile
                </option>
                <option value="warmHits">Eligible warm hits</option>
                <option value="everyRequest">Every request</option>
              </select>
            </label>
            {factField(
              'Target fraction (0–1)',
              input.experience.targetPercentile,
              (n) =>
                edit((d) => {
                  d.experience.targetPercentile = n ?? 0;
                }),
              0.01,
            )}
          </div>
          <div className="checks">
            {(['cacheAllowed', 'schedulingAllowed'] as const).map((key) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={input.infrastructure[key]}
                  onChange={(e) =>
                    edit((d) => {
                      d.infrastructure[key] = e.target.checked;
                    })
                  }
                />
                {key === 'cacheAllowed'
                  ? 'Cache infrastructure permitted'
                  : 'Scheduling permitted'}
              </label>
            ))}
            <label>
              <input
                type="checkbox"
                checked={input.experience.allowDeferred}
                onChange={(e) =>
                  edit((d) => {
                    d.experience.allowDeferred = e.target.checked;
                  })
                }
              />
              Later live updates permitted
            </label>
            <label>
              <input
                type="checkbox"
                checked={input.experience.allowSlowMiss}
                onChange={(e) =>
                  edit((d) => {
                    d.experience.allowSlowMiss = e.target.checked;
                  })
                }
              />
              Slow miss path permitted
            </label>
          </div>
          <div className="analyze-row">
            <p>
              Declared estimates are welcome.
              <br />
              Missing evidence stays visible.
            </p>
            <button
              className="dark"
              disabled={busy}
              onClick={() => void analyze()}
            >
              {busy ? 'Evaluating…' : 'Suggest design'}{' '}
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </section>
        {error && (
          <div role="alert" className="notice error">
            {error}
          </div>
        )}
        <section id="designs" className="panel">
          <div className="section-heading">
            <span className="step">03</span>
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
          {!report ? (
            <div className="empty-state">
              Your requirements become the comparison.
              <small>
                Six bounded patterns and compositions. No hidden provider
                switching.
              </small>
            </div>
          ) : (
            <>
              {changeNote && <p className="notice">{changeNote}</p>}
              <p className="outcome">
                {report.selectedId
                  ? 'A design meets the stated requirements under its assumptions.'
                  : 'No feasible candidate under the supplied facts and supported catalog.'}
              </p>
              <div className="design-grid">
                <div
                  className="candidate-list"
                  role="group"
                  aria-label="Architecture alternatives"
                >
                  {report.candidates.map((c) => (
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
                  {report.costRankingAvailable
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
            <span className="step">04</span>
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
          <p>Evidence before confidence. Architecture before orchestration.</p>
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
