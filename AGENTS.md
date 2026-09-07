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
    index.ts      # Public exports: Monitor, attachAxiosMonitor, types
    client.ts     # Monitor class — queue, batching, flush, browser auto-capture, lifecycle
    axios.ts      # attachAxiosMonitor(instance, monitor, opts) — reports API failures
    types.ts      # MonitorConfig, MonitorEvent, EmitOptions, LogLevel
    *.test.ts     # vitest unit tests (35 tests)
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
new Monitor(config)         # starts flush timer + installs browser auto-capture
  → monitor.info/warn/error/debug/fatal(name, {requestId, traceId, userId, data})
  → emit(): build MonitorEvent, push to in-memory queue (cap MAX_QUEUE_SIZE=500, drops OLDEST on overflow)
  → auto-flush when queue length ≥ batchSize; else on flushInterval timer
  → flush(): NDJSON = batch.map(JSON.stringify).join("\n"); POST fetch(keepalive:true)
             on failure, re-queue the batch if there's room
Browser lifecycle: flush on visibilitychange→hidden and pagehide.
shutdown(): clear timer, flush, remove listeners.
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
(`sha256(service | name | path | normalizedMessage)`), so anything put here is both
retained and grouped on. Adding a query string would leak personal data into issue
identity and shatter one issue into thousands.

Consequence to know when changing this: because `path` feeds the fingerprint, the
same error on two routes is now **two issues**. That is the intent — it tells you
where a client error actually happens — but it does mean issue counts for existing
browser errors re-key when this ships. The Node handlers deliberately omit `path`;
there is no location server-side.

Public API: `Monitor` (`setUser`/`clearUser`/`setJobId`, `emit`, `debug`/`info`/`warn`/
`error`/`fatal`, `flush`, `shutdown`), `attachAxiosMonitor`, and the types.

### Config (types.ts)

| Field | Default | Notes |
|---|---|---|
| `service` | — | **Required.** |
| `ingestUrl` | — | **Required.** Full ingest endpoint (e.g. `https://monitor.appleby.cloud/v1/events`). |
| `apiKey` | — | Sent as `X-Api-Key`. |
| `env` | `"production"` | |
| `flushInterval` | 2000ms | |
| `batchSize` | 20 | auto-flush threshold |
| `captureErrors` | true | browser `window.onerror` **or** Node `process.on("uncaughtException")` |
| `captureUnhandledRejections` | true | browser `unhandledrejection` **or** Node `process.on("unhandledRejection")` |
| `debug` | false | |
| `ignoreErrors` | `[]` | string/RegExp patterns dropped before queueing (applies to auto-captured errors) |

`MAX_QUEUE_SIZE` (500) is a hard cap in `client.ts` — not configurable.

---

## 6. Wire-format / ingestion contract

Must match `go-monitor` and be accepted by `monitor-core`'s `POST /v1/events`.

- **Request:** `POST <ingestUrl>`, `fetch` with `keepalive: true`.
- **Headers:** `Content-Type: application/x-ndjson`, `X-Api-Key: <apiKey>`.
- **Body:** NDJSON, one event per line (`JSON.stringify` joined by `\n`). ⚠️ **No
  trailing newline** after the last line (go-monitor adds one) — harmless with
  monitor-core's line parser.
- **Event shape** (`types.ts` `MonitorEvent`): `timestamp` (ISO), `service`, `env`,
  `job_id`, `request_id`, `trace_id`, `user_id`, `name`, `level`, `data`.
  ⚠️ Unlike go-monitor (omitempty), monitor-js **always sends** `job_id`/`request_id`/
  `trace_id`/`user_id` as `""` and `data` as `{}` when unset. monitor-core only requires
  `timestamp`/`service`/`name`, so this is accepted — but the two SDKs emit different
  bytes for the same logical event. Keep this in mind when comparing SDK output.
- **Levels:** `debug`/`info`/`warn`/`error`/`fatal`.

---

## 7. Ecosystem & related repos

| Repo | Relationship |
|---|---|
| `monitor-core` | Ingestion target — `POST /v1/events` + `IngestAuthMiddleware` (reads `X-Api-Key`). §6 is the contract. |
| `go-monitor` | The Go SDK. Keep the wire format in lockstep (see its AGENTS §6). |
| `monitor-web` | Uses this SDK for browser-side error capture. |

---

## 8. `attachAxiosMonitor`

Generic Axios failure reporter (not monitor-core-specific): stamps request start time,
then on responses/errors emits `api.request.server_error` (≥500), `api.request.client_error`
(≥`minStatus`, default 400), `api.request.network_error` (no response), and optionally
`api.request.success`. Correlates via the `x-request-id` response header. Works with both
default Axios throw-on-non-2xx and `validateStatus: () => true`. Options: `minStatus`,
`reportSuccess`, `ignorePaths`. It reads `data.error`/`data.error_message` off responses —
a generic guess, not tied to monitor-core's `{message}` envelope.

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

**Fixed (2026-07-23):** B1 (fetch-absent data loss — fetch check now precedes the splice
in `flush()`), B2 (flush timer now `.unref()`'d in Node), and B3 (Node auto-capture now
attaches `process.on` handlers). See §5 "Runtime coverage".

Build + typecheck + tests are green (`tsc` clean, 35/35 vitest).

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
