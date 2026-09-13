# monitor-js

Lightweight JavaScript/TypeScript client for the Monitor platform — ships structured
events (and auto-captured browser errors) as NDJSON to `monitor-core`.

> **Monitor platform** · TypeScript SDK · `@aidenappleby/monitor-js` (npm)

---

## Overview

`monitor-js` is the browser/Node SDK for Monitor, the counterpart to `go-monitor`. It
queues and batches events, ships them to a zone's ingest endpoint over `fetch`, and can
auto-capture uncaught errors and unhandled promise rejections (browser and Node). It keeps
the same wire format as the Go SDK — including its rules for surviving ingest's
all-or-nothing validation: invalid ids are cleared before sending, a rejected batch is
split until only the malformed event is dropped, and transient failures are retried with
backoff instead of discarded.

## Install

```bash
npm install @aidenappleby/monitor-js
```

## Usage

```ts
import { Monitor } from "@aidenappleby/monitor-js";

const monitor = new Monitor({
  service: "my-web-app",
  ingestUrl: "https://appleby-monitor-api.appleby.cloud/v1/events", // one zone's ingest endpoint
  apiKey: process.env.MONITOR_API_KEY!,   // ingest-scoped key minted on that zone
  env: "production",
  onDrop: (total) => droppedEvents.set(total), // optional: be told about loss
});

monitor.setUser("user_123");
monitor.info("checkout.start.success", { data: { cartTotal: 4200 } });
monitor.error("checkout.payment.failed", { data: { reason: "card_declined" } });

monitor.stats(); // { enqueued, flushed, dropped, quarantined, queued }

// on teardown
monitor.shutdown();
```

> **In a browser, `apiKey` is public** — anyone who loads the page can read it. Prefer
> pointing `ingestUrl` at a route on your own origin that forwards to Monitor server-side.

Uncaught errors and unhandled rejections are captured automatically in **both** the
browser (`window`) and Node (`process.on`) — disable with `captureErrors: false` /
`captureUnhandledRejections: false`. Filter noise with
`ignoreErrors: [/extension/i, "ResizeObserver"]`.

In Node, installing a process listener would normally stop an uncaught exception from
crashing the process. The SDK keeps Node's behavior: when it is the **only**
`uncaughtException` listener, it reports, prints the error, waits up to 1.5s for the batch
to leave, and exits 1; an unhandled rejection with no other listener is re-raised as an
uncaught exception, exactly as Node does by default. If your app has its own listener, the
SDK only reports. Server code that manages its own crash handling (e.g. a Next.js
`instrumentation.ts`) should pass `captureErrors: false, captureUnhandledRejections: false`.

### Correlation ids

`request_id`, `trace_id` and `job_id` must be a UUID or 8–64 hex characters — anything
else is cleared before sending and kept in `data.invalid_<field>`. Each `Monitor` mints a
session `job_id`; mint the others with the helpers:

```ts
import { newRequestId, newTraceId, isValidCorrelationId } from "@aidenappleby/monitor-js";

monitor.info("upload.start.success", { requestId: newRequestId(), traceId: newTraceId() });
```

### Axios integration

```ts
import axios from "axios";
import { attachAxiosMonitor } from "@aidenappleby/monitor-js";

const api = axios.create({ baseURL: "/api", validateStatus: () => true });
attachAxiosMonitor(api, monitor, { ignorePaths: ["/health"] });
```

Reported URLs have their query string removed.

## Role in the Monitor ecosystem

- **`monitor-core`** — ingestion target (`POST /v1/events`, `X-Api-Key`).
- **`go-monitor`** — the Go SDK; shares the wire format and delivery rules.
- **`monitor-web`** — displays the events (it does not use this SDK).

## Development

| Command | What it does |
|---|---|
| `npm run check` | `tsc --noEmit` |
| `npm test` | vitest |
| `npm run build` | tsup → `dist/` (CJS + ESM + d.ts) |

Publishing to npm runs the build via `prepublishOnly` and requires 2FA.

## Contributing & further reading

Read **[AGENTS.md](./AGENTS.md)** before working here — it documents the event pipeline,
the delivery rules, the exact wire contract (kept in lockstep with `go-monitor` /
`monitor-core`), the config surface, and current known issues.
