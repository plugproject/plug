import React, { useEffect, useRef, useState } from 'react';
import { guardDocument } from '../../../../packages/plug/src/contracts/index';
import type {
  DesignInput,
  JsonObject,
  Operation,
  SystemDescription,
} from '../../../../packages/plug/src/contracts/index';
import type { Discovery } from '../../../../packages/plug/src/discovery/index';
import {
  importA2a,
  importMcp,
  openApiSystem,
} from '../../../../packages/plug/src/importers/index';
import { setOperations, uniqueId } from './model';
/** A listed tool or skill, and why Plug cannot use it when it cannot. */
type Method = {
  id: string;
  title: string;
  description: string;
  problem: string | null;
  raw: JsonObject;
};
const isObject = (v: unknown): v is JsonObject =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v : '');
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
function methodsOf(found: Discovery): Method[] {
  if (found.protocol === 'a2a')
    return (Array.isArray(found.card.skills) ? found.card.skills : []).flatMap(
      (s) =>
        isObject(s) && typeof s.id === 'string' && s.id
          ? [
              {
                id: s.id,
                title: text(s.name),
                description: text(s.description),
                problem: null,
                raw: s,
              },
            ]
          : [],
    );
  if (found.protocol === 'http')
    return found.operations.flatMap((o) => {
      if (!isObject(o) || typeof o.id !== 'string' || !o.id) return [];
      const http = isObject(o.metadata)
        ? (o.metadata.http as JsonObject | undefined)
        : undefined;
      const title = isObject(http)
        ? `${text(http.method).toUpperCase()} ${text(http.path)}`.trim()
        : '';
      return [
        {
          id: o.id,
          title,
          description: text(o.description),
          problem: null,
          raw: o,
        },
      ];
    });
  return found.tools.map((t) => {
    let problem: string | null = null;
    if (!isObject(t.inputSchema))
      problem = 'No input schema; MCP tools must declare one.';
    else
      try {
        guardDocument(t);
      } catch (e) {
        problem = `${(e as Error).message}.`;
      }
    return {
      id: String(t.name),
      title: text(t.title),
      description: text(t.description),
      problem,
      raw: t,
    };
  });
}
/** Header lines written as `Name: value`; blank lines are ignored. */
export function parseHeaderLines(source: string): Record<string, string> {
  const headers: Record<string, string> = {};
  source.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const at = line.indexOf(':');
    if (at < 1)
      throw new Error(`Header line ${i + 1}: write it as Name: value.`);
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  });
  return headers;
}
/** The URL as it may be kept in the design: no credentials, query or fragment. */
export function savedEndpoint(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.username = u.password = u.search = u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}
interface ServerDiscoveryProps {
  input: DesignInput;
  system: SystemDescription;
  /** Only the local workbench reaches servers; the hosted playground never does. */
  local: boolean;
  edit: (fn: (next: DesignInput) => void) => void;
  onApplied?: (systemId: string, name: string) => void;
}
/** Server or document details for a system, and the tools, skills or operations it lists. */
export function ServerDiscovery({
  input,
  system,
  local,
  edit,
  onApplied,
}: ServerDiscoveryProps) {
  const face = system.interfaces[0];
  const protocol = face.protocol;
  const noun =
    protocol === 'mcp' ? 'tool' : protocol === 'a2a' ? 'skill' : 'operation';
  const lastDiscovery = isObject(system.metadata?.discovery)
    ? system.metadata.discovery
    : undefined;
  /** A system that has never named a server nor been discovered: index it first. */
  const fresh = !face.endpoint && !lastDiscovery;
  const [url, setUrl] = useState(
    // An HTTP system's endpoint is its server base; the document URL is kept
    // as discovery provenance and prefilled here.
    protocol === 'http'
      ? typeof lastDiscovery?.url === 'string'
        ? lastDiscovery.url
        : ''
      : (face.endpoint ?? ''),
  );
  const [headerText, setHeaderText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [found, setFound] = useState<Discovery | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [result, setResult] = useState<{ text: string; gaps: string[] } | null>(
    null,
  );
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const links = (id: string) =>
    input.connections.filter(
      (c) =>
        (c.callerSystemId === system.id && c.callerOperationId === id) ||
        (c.downstreamSystemId === system.id && c.downstreamOperationId === id),
    ).length;
  const usableIds = (methods: Method[]) =>
    new Set(methods.filter((m) => !m.problem).map((m) => m.id));
  const methods = found ? methodsOf(found) : [];
  const usable = usableIds(methods);
  /** Operations the server does not list in a usable form; kept only when picked. */
  const others = system.operations.filter((o) => !usable.has(o.id));
  const dropping = system.operations.filter((o) => !picked.includes(o.id));
  const dropLinks = dropping.reduce((n, o) => n + links(o.id), 0);
  const matches = (...parts: string[]) =>
    !filter ||
    parts.join(' ').toLowerCase().includes(filter.trim().toLowerCase());
  const serverName = !found
    ? ''
    : found.protocol === 'mcp'
      ? (found.server.title ?? found.server.name)
      : found.protocol === 'http'
        ? found.info.title
        : text(found.card.name) || 'Agent';
  const firstPicks = (next: Discovery) => {
    const listed = methodsOf(next),
      ids = usableIds(listed);
    const kept = system.operations
      .filter((o) => ids.has(o.id) || links(o.id) > 0)
      .map((o) => o.id);
    if (kept.length) return kept;
    return [...ids];
  };
  const saveUrl = () => {
    // The OpenAPI document URL is not the server endpoint; applying a
    // discovery sets the endpoint from the document's servers entry.
    if (protocol === 'http') return;
    const next = savedEndpoint(url);
    if (!next || next === face.endpoint) return;
    edit((d) => {
      d.systems.find((s) => s.id === system.id)!.interfaces[0].endpoint = next;
    });
  };
  const run = async () => {
    setProblem('');
    setResult(null);
    let headers: Record<string, string>;
    try {
      headers = parseHeaderLines(headerText);
    } catch (e) {
      return setProblem((e as Error).message);
    }
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    try {
      const r = await fetch('/api/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol, url: url.trim(), headers }),
        signal: controller.signal,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok)
        throw new Error(
          data.error ?? `Discovery failed with HTTP ${r.status}.`,
        );
      setFound(data as Discovery);
      setPicked(firstPicks(data as Discovery));
      setFilter('');
    } catch (e) {
      if (!controller.signal.aborted) setProblem((e as Error).message);
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  const cancel = () => {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
  };
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const apply = () => {
    if (!found) return;
    const chosen = methods.filter((m) => !m.problem && picked.includes(m.id));
    const kept = others.filter((o) => picked.includes(o.id)).map((o) => o.id);
    let summary = { name: '', removed: 0, links: 0, gaps: [] as string[] };
    const change = (d: DesignInput) => {
      const s = d.systems.find((x) => x.id === system.id)!;
      const was = s.interfaces[0];
      const review = !chosen.length
        ? null
        : found.protocol === 'mcp'
          ? importMcp({
              serverId: s.id,
              serverName,
              protocolVersion: found.protocolVersion,
              response: { tools: chosen.map((m) => m.raw) },
            })
          : found.protocol === 'http'
            ? openApiSystem({
                id: s.id,
                name: serverName,
                openapiVersion: found.openapiVersion,
                serverUrl: found.serverUrl,
                operations: chosen.map((m) => m.raw) as unknown as Operation[],
                documentUrl: found.url,
              })
            : importA2a(
                { ...found.card, skills: chosen.map((m) => m.raw) },
                s.id,
              );
      if (found.protocol === 'mcp')
        s.interfaces[0] = {
          ...was,
          protocol: 'mcp',
          version: found.protocolVersion,
          direction: 'exposes',
          binding: 'MCP',
          endpoint: found.url,
        };
      else if (found.protocol === 'http')
        s.interfaces[0] = {
          ...was,
          protocol: 'http',
          version: '1.1',
          direction: 'exposes',
          binding: 'HTTP+JSON',
          ...(found.serverUrl ? { endpoint: found.serverUrl } : {}),
        };
      else if (review) {
        const rest = s.interfaces.slice(1);
        const taken = [was.id, ...rest.map((i) => i.id)];
        s.interfaces = [
          ...review.system.interfaces.map((f, i) => {
            const id = i === 0 ? was.id : uniqueId(f.id, taken);
            taken.push(id);
            return { ...f, id };
          }),
          ...rest,
        ];
      }
      const faceId = s.interfaces[0].id;
      const next: Operation[] = [
        ...(review?.system.operations ?? []).map((o) => {
          const old = s.operations.find((x) => x.id === o.id);
          // Operational facts the author entered outrank listed metadata.
          return old
            ? {
                ...o,
                interfaceId: faceId,
                semantics: old.semantics,
                ...(old.interaction ? { interaction: old.interaction } : {}),
              }
            : { ...o, interfaceId: faceId };
        }),
        ...kept.map((id) => s.operations.find((o) => o.id === id)!),
      ];
      const removed = s.operations.filter(
        (o) => !next.some((x) => x.id === o.id),
      ).length;
      const removedLinks = setOperations(d, s.id, next);
      if (review && s.name === 'New system') s.name = review.system.name;
      s.metadata = {
        ...s.metadata,
        discovery: {
          protocol: found.protocol,
          url: found.url,
          discoveredAt: found.discoveredAt,
          // The workbench's own fetch time: synthetic, not a production measurement.
          fetchMs: found.fetchMs,
          ...(found.protocol === 'mcp'
            ? {
                server: { ...found.server },
                protocolVersion: found.protocolVersion,
                complete: found.complete,
              }
            : found.protocol === 'http'
              ? {
                  openapiVersion: found.openapiVersion,
                  complete: found.complete,
                }
              : {}),
        } as JsonObject,
      };
      summary = {
        name: s.name,
        removed,
        links: removedLinks.length,
        gaps: review?.gaps ?? [],
      };
    };
    try {
      change(structuredClone(input));
    } catch (e) {
      return setProblem((e as Error).message);
    }
    edit(change);
    onApplied?.(system.id, summary.name || system.name);
    const source = summary.name === serverName ? 'the server' : serverName;
    const parts = [
      chosen.length && `${plural(chosen.length, noun)} from ${source}`,
      kept.length && `${plural(kept.length, 'operation')} kept as entered`,
    ].filter(Boolean);
    setResult({
      text: `${summary.name} now has ${parts.join(' and ')}.${
        summary.removed
          ? ` Removed ${plural(summary.removed, 'operation')}${summary.links ? ` and ${plural(summary.links, 'connection')}` : ''}; undo restores them.`
          : ''
      }`,
      gaps: summary.gaps,
    });
    setFound(null);
    setPicked([]);
  };
  return (
    <section
      className="discovery"
      aria-label={
        protocol === 'mcp'
          ? 'MCP server'
          : protocol === 'a2a'
            ? 'A2A agent'
            : 'OpenAPI service'
      }
    >
      <h3>
        {protocol === 'mcp'
          ? 'MCP server'
          : protocol === 'a2a'
            ? 'A2A agent'
            : 'OpenAPI service'}
      </h3>
      <label>
        {protocol === 'mcp'
          ? 'Streamable HTTP endpoint'
          : protocol === 'a2a'
            ? 'Agent URL or Agent Card URL'
            : 'OpenAPI document URL'}
        <input
          type="url"
          value={url}
          placeholder={
            protocol === 'mcp'
              ? 'https://example.com/mcp'
              : protocol === 'a2a'
                ? 'https://agent.example.com'
                : 'https://example.com/openapi.json'
          }
          spellCheck={false}
          autoComplete="off"
          // A just-added system starts at its server: enter the URL and press
          // Enter to list what it exposes before describing anything by hand.
          autoFocus={local && fresh}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={saveUrl}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !local || busy || !url.trim()) return;
            e.preventDefault();
            saveUrl();
            void run();
          }}
        />
      </label>
      {local ? (
        <>
          <label>
            Request headers · optional, one per line, never saved
            <textarea
              rows={2}
              value={headerText}
              placeholder="Authorization: Bearer …"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setHeaderText(e.target.value)}
            />
          </label>
          <div className="discovery-actions">
            <button
              type="button"
              disabled={busy || !url.trim()}
              onClick={() => void run()}
            >
              {busy ? 'Discovering…' : `Discover ${noun}s`}
            </button>
            {busy && (
              <button type="button" className="text-button" onClick={cancel}>
                Cancel
              </button>
            )}
          </div>
          <p className="small">
            {protocol === 'mcp'
              ? 'Plug opens a session, lists the tools and ends the session. It never calls a tool.'
              : protocol === 'a2a'
                ? 'Plug reads the public Agent Card. It never sends the agent a message.'
                : 'Plug reads the OpenAPI document. It never calls an operation.'}{' '}
            The URL is kept without its query string; headers are not kept.
          </p>
        </>
      ) : (
        <p className="small">
          Discovery runs in the local workbench, which can reach your servers:
          run <code>npx plug ui</code> in your project. This hosted playground
          never contacts them; paste a tools/list response, Agent Card or
          OpenAPI document under Import metadata instead.
        </p>
      )}
      {problem && (
        <p className="small discovery-problem" role="alert">
          {problem}
        </p>
      )}
      {found && (
        <fieldset className="discovery-list">
          <legend>
            {serverName} ·{' '}
            {found.protocol === 'mcp'
              ? `MCP ${found.protocolVersion}`
              : found.protocol === 'http'
                ? `OpenAPI ${found.openapiVersion}`
                : 'Agent Card'}{' '}
            · {plural(methods.length, noun)}
          </legend>
          {found.notes.map((n) => (
            <p key={n} className="small">
              {n}
            </p>
          ))}
          <p className="small">
            Listed in {found.fetchMs} ms by this workbench — a synthetic
            observation, not a production measurement.
          </p>
          <p className="small">
            Choose this system&apos;s operations · {picked.length} chosen
          </p>
          {methods.length + others.length > 8 && (
            <input
              type="search"
              aria-label={`Filter ${noun}s`}
              placeholder={`Filter ${noun}s`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          <ul>
            {methods
              .filter((m) => matches(m.id, m.title, m.description))
              .map((m) => {
                const on = picked.includes(m.id);
                return (
                  <li key={m.id}>
                    <label className={m.problem ? 'unusable' : undefined}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!!m.problem}
                        onChange={() => toggle(m.id)}
                      />
                      <span>
                        <strong>
                          {m.id}
                          {m.title && m.title !== m.id ? ` · ${m.title}` : ''}
                        </strong>
                        <small>
                          {m.problem ?? (m.description || 'No description')}
                        </small>
                      </span>
                    </label>
                  </li>
                );
              })}
            {others
              .filter((o) => matches(o.id, o.description))
              .map((o) => {
                const on = picked.includes(o.id),
                  n = links(o.id);
                return (
                  <li key={`own-${o.id}`}>
                    <label>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggle(o.id)}
                      />
                      <span>
                        <strong>{o.id}</strong>
                        <small>
                          {methods.some((m) => m.id === o.id)
                            ? 'Kept as entered: the listed definition is unusable'
                            : 'Not listed by the server'}
                          {n ? ` · ${plural(n, 'connection')}` : ''}
                        </small>
                      </span>
                    </label>
                  </li>
                );
              })}
          </ul>
          {picked.length > 0 && dropping.length > 0 && (
            <p className="small">
              Applying removes {dropping.map((o) => o.id).join(', ')}
              {dropLinks ? ` and ${plural(dropLinks, 'connection')}` : ''}.
            </p>
          )}
          <div className="discovery-actions">
            <button
              type="button"
              className="dark"
              disabled={!picked.length}
              onClick={apply}
            >
              Apply to {system.name}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setFound(null)}
            >
              Discard
            </button>
          </div>
        </fieldset>
      )}
      {result && (
        <div className="discovery-result" role="status">
          <p className="small">{result.text}</p>
          {result.gaps.length > 0 && (
            <ul aria-label="What Plug still needs" className="link-list">
              {result.gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
