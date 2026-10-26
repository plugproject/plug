# Evidence and honesty

- Unknown stays unknown. Never invent latency, quotas, availability,
  concurrency, freshness, cache permission, output meaning, workload, or
  delivery guarantees.
- `probed` evidence describes the local workbench's vantage, time window, and
  samples. It is not production telemetry and cannot establish a production
  SLO.
- A warm-hit measurement is not a traffic percentile. A timeout is a hard
  bound, not p95. Do not add component p95 values to claim end-to-end p95.
- Cache headers are hints. Only the author's declared cache permission allows a
  cache.
- Synthetic replay and fixtures are not observed production measurements.
- A model proposal is not a fact. The author adopts drafted facts and design
  choices. Jev judgments are pinned to their exact state and qualify only the
  question they answer.
- The deterministic engine owns feasibility. A critique cannot turn a failed
  hard requirement into a passing architecture.
- Never invoke a descriptor-supplied host during hosted analysis. Local probing
  requires the host to have been added and authorized, enforces call/time/byte
  bounds, and stops on the first rate limit.
- Never serialize API keys, authorization values, cookies, passwords, or
  secrets. Persist `${env:NAME}` references and resolve them only for the
  authorized local request.
