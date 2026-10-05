---
title: Local discovery of MCP tools and A2A skills
status: draft
---

This proposal has no PR number, sponsor or approval yet. It builds on the local
workbench and workflow graph proposals and does not change the serialized
format.

## Motivation

An MCP or A2A system is described by pasting a `tools/list` response or an
Agent Card into metadata import. Developers rarely have that document at hand;
they have a server URL and a token. Copying a listing by hand is slow, and a
large server lists more tools than one system may select.

## Specification

### Server details

A system whose first interface exposes MCP or A2A shows its server details in
the inspector: the MCP Streamable HTTP endpoint, or the A2A agent URL or Agent
Card URL. The URL is kept as the interface `endpoint` without credentials,
query string or fragment. A system that calls the protocol has no server to
describe.

### Discovery

Only the local workbench discovers. `POST /api/discover` accepts
`{ protocol, url, headers }` as JSON from the workbench's own origin. The URL is
an absolute `http://` or `https://` URL of at most 2048 characters without
credentials. Up to eight single-line headers, 8 KB in total, may carry
credentials; headers the transport manages (`Host`, `Origin`, `Accept`,
`Content-Type`, `Mcp-Session-Id`, `Mcp-Protocol-Version` and hop-by-hop
headers) are refused. A new discovery replaces one still running.

- MCP: Plug initializes a Streamable HTTP session, pages through `tools/list`
  and ends the session. Beyond the initialization handshake and the session's
  own stream and closing requests it sends nothing; it never calls a tool.
  Listing stops after 20 pages, 500 tools or 2 MB, at a repeated cursor, or
  when the server declares no tools capability; the result then says it may be
  incomplete.
- A2A: Plug reads the Agent Card at a URL ending in `.json`, otherwise at
  `<path>/.well-known/agent-card.json`, `/.well-known/agent-card.json` and
  `/.well-known/agent.json`, in that order. It never sends the agent a message.
  A card without `supportedInterfaces` predates A2A 1.0 and is read with that
  note and no compatibility claim.

Each response is limited to 1 MB, an Agent Card to 256 KB, the whole discovery
to 15 seconds, and redirects to three that stay within the origin or upgrade it
to `https` on default ports, so headers never reach another origin. Failures
say what to change: a refused request names its HTTP status and suggests a
header; a redirect to another origin names the URL to enter instead.

The result lists the endpoint without its query, the server name and version
or the card, the protocol version, every listed tool or skill, and notes. The
inspector marks tools Plug cannot use (no object input schema, or a definition
the document guards reject), filters long lists, and lets the author choose at
most four as the system's operations. Applying passes the chosen definitions
through the existing MCP and A2A importers, so the facts Plug still needs are
listed and annotations never become cache permission or any other operational
fact. Operations the author already described keep their semantics; operations
no longer chosen are removed with their connections, as the inspector states
before applying, and undo restores them. A system still named "New system"
takes the server's name. `metadata.discovery` records the protocol, public URL,
time, and for MCP the server, protocol version and whether the listing was
complete.

The hosted playground shows the same server details but never discovers: it
explains that discovery runs in `plug ui` and points to metadata import.

## Rationale

Listing is the only step that needs the network, and the workbench already
runs on the developer's machine, where their servers and credentials are.
Reusing the importers keeps one review path for pasted and discovered
metadata, including its gaps. Ending the MCP session and refusing tool calls
keeps discovery free of side effects; following redirects only within the
origin keeps credentials with the server they were entered for.

## Compatibility

No contract changes: `endpoint` and `metadata` already exist on interfaces and
systems, and discovered operations are ordinary operations. Inputs without
`metadata.discovery` behave as before; hashes change only when an author
applies a discovery.

## Alternatives

- Discovery from the hosted playground: rejected; hosted analysis never
  contacts user infrastructure or collects credentials.
- Calling a tool to measure it: rejected; discovery must not cause effects,
  and synthetic observations are not production measurements.
- Storing headers for later rediscovery: rejected; credentials stay in the
  form for one request and are never written.
- MCP over stdio: deferred; starting a local command needs its own consent
  and sandboxing model.

## Security implications

The endpoint is local-only, same-origin, JSON-only and bounded as above.
Headers are used for the discovery requests only; they are not stored, logged,
returned or written into the input, the workspace or the spec bundle, and the
query string is forwarded but never kept. The browser bundle contains no
discovery client. Discovered definitions pass the document guards before they
are shown or imported, and nothing discovered is ever invoked.

## Implementation

- Discovery: `packages/plug/src/discovery/index.ts`, using
  `@modelcontextprotocol/sdk` for the Streamable HTTP client.
- Workbench endpoint: `packages/plug/src/ui/server.ts`.
- Inspector: `apps/playground/src/workflow/Discovery.tsx` and
  `apps/playground/src/workflow/Inspector.tsx`.

Remaining work before finalization: owner review, trials against production
MCP servers and A2A agents, and OAuth flows for servers that require them.

## Validation

See [discovery tests](../tests/discovery.test.ts), with local MCP and A2A
[fixture servers](../tests/fixtures/discovery-servers.ts), and
[local workbench tests](../tests/ui-server.test.ts). The
[browser suite](../tests/browser/playground.spec.ts) discovers both protocols in
the workbench and checks that the hosted playground never contacts a server.
This proposal remains draft pending owner review.
