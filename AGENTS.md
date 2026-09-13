# AGENTS.md — monitor-js

> The comprehensive working document for this repo. An agent that reads only this
> file should be able to work in monitor-js correctly. Keep it current — see
> **Keeping this file updated** at the bottom.

---

## 1. What this repo is

`monitor-js` is the **JavaScript/TypeScript SDK** for the Monitor platform
(`@aidenappleby/monitor-js`, published to npm). Browser and Node apps import it to emit
structured events and ship them as NDJSON to `monitor-core`'s ingestion endpoint. It is
the TypeScript counterpart to `go-monitor` and must keep the **same wire format** (§6).

It **owns**: the client event model, batching/queueing, browser auto-capture
(`window.onerror` + unhandled rejections), lifecycle flush hooks, and an Axios
interceptor helper. It **does not** own ingestion/storage/query (that's `monitor-core`).

---

## 2. Stack & dependencies

- TypeScript (strict), built with **tsup** to CJS + ESM + d.ts (`dist/`).
- Tests with **vitest**. **Zero runtime dependencies** — uses the global `fetch`.
- Targets both browser and Node ≥18 (relies on global `fetch`). Auto-capture, timer
  lifecycle, and fetch-absent handling all work in Node — see §5 "Runtime coverage".

---

## 3. Project structure

```
monitor-js/
  src/
    index.ts          # Public exports: Monitor, attachAxiosMonitor, id helpers, types
    client.ts         # Monitor class — queue, batching, delivery (status handling, bisection,
                      #   backoff), browser/Node auto-capture, lifecycle
    ids.ts            # isValidCorrelationId + newRequestId/newJobId/newTraceId
    axios.ts          # attachAxiosMonitor(instance, monitor, opts) — reports API failures
    types.ts          # MonitorConfig, MonitorEvent, EmitOptions, LogLevel, MonitorStats
    delivery.test.ts  # response handling, bisection, backoff, keepalive, shrinking, ids on events
    *.test.ts         # vitest unit tests (56 tests)
  tsup.config.ts tsconfig.json package.json
```

---

## 4. Running, building & testing

```bash
npm ci
npm run check    # tsc --noEmit
npm test         # vitest run
npm run build    # tsup → dist/ (CJS + ESM + d.ts)
```

Publishing to npm is deployment (`prepublishOnly` runs the build); requires 2FA. A
consumer picks up a new version only after bumping their dep — coordinate wire-format
changes with `monitor-core` and `go-monitor`.

---

## 5. How code is written here — the pipeline

```
new Monitor(config)         # mints a session job_id, starts the flush timer, installs auto-capture
  → monitor.info/warn/error/debug/fatal(name, {requestId, traceId, userId, data})
  → emit(): ids monitor-core would reject → cleared, value kept in data.invalid_<field>;
            level folded ("ERROR"→"error", "warning"→"warn"); push to the queue
            (cap MAX_QUEUE_SIZE=500; overflow drops the OLDEST, counted)
  → auto-flush when queue length ≥ batchSize; else on the flushInterval timer
  → flush(): skipped while backing off after a transient failure
  → send(): serialize each event (never throws; >1 MB lines shrunk to grouping fields);
            POST NDJSON with keepalive only if the body is ≤ 60 KB
  → response:
       2xx/3xx                 → counted flushed; backoff reset
       400/413/422/other 4xx   → split and resend until the malformed event stands alone,
                                 then drop it (quarantined); bounded extra requests
       401/403/404/405         → drop + count; console.warn once per instance
       408/429/5xx/network     → requeue at the front (as room allows) + full-jitter backoff
                                 (1s doubling to 60s)
Browser lifecycle: flush on visibilitychange→hidden and pagehide — these, and shutdown(),
ignore the backoff: it is the last chance those events get.
```

**Runtime coverage.** `flush()` checks for a global `fetch` **before** dequeuing, so on a
runtime without `fetch` (Node <18) events stay queued rather than being dropped. The flush
timer is `.unref()`'d in Node so it never keeps the process alive. Auto-capture works in
**both** environments: the browser attaches `window` `error`/`unhandledrejection`
listeners; Node attaches `process.on("uncaughtException"/"unhandledRejection")`, emitting
the same `client.error.uncaught` / `client.error.unhandled_rejection` events (respecting
`ignoreErrors`). The Node handlers are non-terminating — they report and return, they do
not call `process.exit`, so crash semantics are unchanged. `shutdown()` removes the Node
process listeners along with the browser ones.

**Browser errors carry `data.path`.** Both browser handlers record
`window.location.pathname` — `pathname` only, never `search` or `hash`. Two reasons,
both binding: query strings routinely carry tokens and email addresses, and
monitor-core folds `data.path` into the server-side **issue fingerprint**
(`sha256(project | service | name | path | normalizedMessage)`), so anything put here is both
retained and grouped on. Adding a query string would leak personal data into issue
identity and shatter one issue into thousands.

Consequence to know when changing this: because `path` feeds the fingerprint, the
same error on two routes is now **two issues**. That is the intent — it tells you
where a client error actually happens — but it does mean issue counts for existing
browser errors re-key when this ships. The Node handlers deliberately omit `path`;
there is no location server-side.

Public API: `Monitor` (`setUser`/`clearUser`/`setJobId`, `emit`, `debug`/`info`/`warn`/
`error`/`fatal`, `flush`, `stats`, `shutdown`), `attachAxiosMonitor`,
`isValidCorrelationId`/`newRequestId`/`newJobId`/`newTraceId`, and the types.

**Why the delivery rules look like this.** monitor-core ingest is all-or-nothing: one
line it rejects fails the whole request. Before 1.2.0 the SDK had no `resp.ok` check, so
a `400` resolved as success and the batch was discarded as "sent"; and it forwarded
whatever id a caller supplied, so a single `setJobId("lattice-web-1")` would have 400'd
every batch forever, silently. It also asked for `keepalive` on every request, so a batch
over the browser's 64 KiB keepalive quota failed with a `TypeError` on every retry. And
`JSON.stringify` on circular data threw out of `flush()` — and out of `emit()`, via the
auto-flush.

### Config (types.ts)

| Field | Default | Notes |
|---|---|---|
| `service` | — | **Required.** |
| `ingestUrl` | — | **Required.** One zone's full ingest endpoint (e.g. `https://appleby-monitor-api.appleby.cloud/v1/events`). `https://monitor.appleby.cloud` is the dashboard and ingests nothing. |
| `apiKey` | — | Sent as `X-Api-Key`. Minted on the zone `ingestUrl` points at. **Public in a browser bundle** — prefer a same-origin route that forwards server-side. |
| `env` | `"production"` | |
| `flushInterval` | 2000ms | |
| `batchSize` | 20 | auto-flush threshold |
| `captureErrors` | true | browser `window.onerror` **or** Node `process.on("uncaughtException")` |
| `captureUnhandledRejections` | true | browser `unhandledrejection` **or** Node `process.on("unhandledRejection")` |
| `debug` | false | |
| `ignoreErrors` | `[]` | string/RegExp patterns dropped before queueing (applies to auto-captured errors) |
| `onDrop` | — | `(total) => void`, called with the running total on every loss. A throw is swallowed. |

`MAX_QUEUE_SIZE` (500) is a hard cap in `client.ts` — not configurable.

---

## 6. Wire-format / ingestion contract

Must match `go-monitor` and be accepted by `monitor-core`'s `POST /v1/events`.

- **Request:** `POST <ingestUrl>` with `fetch`; `keepalive: true` only when the body is
  ≤ 60 KB (browsers share a 64 KiB keepalive budget across the page).
- **Headers:** `Content-Type: application/x-ndjson`, `X-Api-Key: <apiKey>`.
- **Body:** NDJSON, one event per line (`JSON.stringify` joined by `\n`). ⚠️ **No
  trailing newline** after the last line (go-monitor adds one) — harmless with
  monitor-core's line parser.
- **Event shape** (`types.ts` `MonitorEvent`): `timestamp` (ISO), `service`, `env`,
  `job_id`, `request_id`, `trace_id`, `user_id`, `name`, `level`, `data`.
  ⚠️ Unlike go-monitor (omitempty), monitor-js **always sends** `request_id`/`trace_id`/
  `user_id` as `""` and `data` as `{}` when unset. `job_id` is a session id minted per
  `Monitor` instance unless `setJobId` overrides it.
- **Ids** must match monitor-core's `^(UUID|[0-9a-fA-F]{8,64})$`; an invalid one is
  cleared before sending (see §5). Mint them with `newRequestId`/`newTraceId`/`newJobId`. monitor-core only requires
  `timestamp`/`service`/`name`, so this is accepted — but the two SDKs emit different
  bytes for the same logical event. Keep this in mind when comparing SDK output.
- **Levels:** `debug`/`info`/`warn`/`error`/`fatal`.

---

## 7. Ecosystem & related repos

| Repo | Relationship |
|---|---|
| `monitor-core` | Ingestion target — `POST /v1/events` + `IngestAuthMiddleware` (reads `X-Api-Key`). §6 is the contract. |
| `go-monitor` | The Go SDK. Keep the wire format in lockstep (see its AGENTS §6). |
| `monitor-web` | Displays the events. It does **not** use this SDK (earlier revisions said it did). |
| Trailblaze `team-dashboard`, `website` | Consumers (Pages Router, direct browser POST with a `NEXT_PUBLIC_` key). |

---

## 8. `attachAxiosMonitor`

Generic Axios failure reporter (not monitor-core-specific): stamps request start time,
then on responses/errors emits `api.request.server_error` (≥500), `api.request.client_error`
(≥`minStatus`, default 400), `api.request.network_error` (no response), and optionally
`api.request.success`. Correlates via the `x-request-id` response header. Works with both
default Axios throw-on-non-2xx and `validateStatus: () => true`. Options: `minStatus`,
`reportSuccess`, `ignorePaths`. It reads `data.error`/`data.error_message` off responses —
a generic guess, not tied to monitor-core's `{message}` envelope. The reported `url` has
its query string and fragment removed: that is where tokens and emails travel.

---

## 9. Rules & guardrails + known issues

**Rules**
- Keep the wire format (§6) in lockstep with `go-monitor` / `monitor-core`.
- Zero runtime deps — don't add any; rely on global `fetch`.
- `emit` must never throw into the caller's hot path.

**Known issues & gaps**

| ID | Sev | Where | Issue |
|---|---|---|---|
| — | 🟢 | §6 | Wire inconsistency vs go-monitor (empty-string fields, no trailing newline). Harmless but worth normalizing if the SDKs are meant to be byte-identical. |
| — | 🟠 | browser | `apiKey` is readable by anyone who loads a page that embeds it. The fix is a same-origin forwarding route in the consuming app, not something the SDK can do alone. |
| — | 🟡 | browser | No Next.js App Router integration (`instrumentation.ts`, `error.tsx`), no redaction, no source maps — minified stacks arrive minified. |

**Fixed (2026-09-12, 1.2.0):** `400` treated as success (now classified, and malformed
events isolated by bisection); invalid correlation ids sent as-is (now cleared, value kept);
no id generator (added, plus a per-instance session `job_id`); keepalive requested on bodies
over the browser quota (now only ≤ 60 KB); `emit()` could throw on circular data (never now);
retries hammered a failing ingest (now full-jitter backoff); loss invisible (`stats()` and
`onDrop`); axios `url` carried query strings (stripped).

**Fixed (2026-07-23):** B1 (fetch-absent data loss — fetch check now precedes the splice
in `flush()`), B2 (flush timer now `.unref()`'d in Node), and B3 (Node auto-capture now
attaches `process.on` handlers). See §5 "Runtime coverage".

Build + typecheck + tests are green (`tsc` clean, 56/56 vitest).

---

## 10. Verification

```bash
npm run check     # tsc --noEmit
npm test          # vitest
npm run build     # tsup
```

If a change alters the wire format (§6) or public API (§5), update this file **and**
coordinate with `monitor-core` / `go-monitor` in the same effort.

---

## 11. Keeping this file updated

Any change to the pipeline, the wire contract (§6), the public API, or the Config shape
MUST update this file in the same change. When a §9 finding is fixed, delete its row.
