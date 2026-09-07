# monitor-js

Lightweight JavaScript/TypeScript client for the Monitor platform — ships structured
events (and auto-captured browser errors) as NDJSON to `monitor-core`.

> **Monitor platform** · TypeScript SDK · `@aidenappleby/monitor-js` (npm)

---

## Overview

`monitor-js` is the browser/Node SDK for Monitor, the counterpart to `go-monitor`. It
queues and batches events, ships them to `monitor-core`'s ingest endpoint over `fetch`,
and can auto-capture uncaught errors and unhandled promise rejections (browser and Node). It keeps
the same wire format as the Go SDK.

## Install

```bash
npm install @aidenappleby/monitor-js
```

## Usage

```ts
import { Monitor } from "@aidenappleby/monitor-js";

const monitor = new Monitor({
  service: "my-web-app",
  ingestUrl: "https://monitor.appleby.cloud/v1/events",
  apiKey: process.env.MONITOR_API_KEY!,   // ingest-scoped key
  env: "production",
});

monitor.setUser("user_123");
monitor.info("checkout.started", { data: { cartTotal: 4200 } });
monitor.error("checkout.failed", { data: { reason: "card_declined" } });

// on teardown
monitor.shutdown();
```

Uncaught errors and unhandled rejections are captured automatically in **both** the
browser (`window`) and Node (`process.on`) — disable with `captureErrors: false` /
`captureUnhandledRejections: false`. Filter noise with
`ignoreErrors: [/extension/i, "ResizeObserver"]`. The Node handlers report and return;
they do not alter process-crash behavior.

### Axios integration

```ts
import axios from "axios";
import { attachAxiosMonitor } from "@aidenappleby/monitor-js";

const api = axios.create({ baseURL: "/api", validateStatus: () => true });
attachAxiosMonitor(api, monitor, { ignorePaths: ["/health"] });
```

## Role in the Monitor ecosystem

- **`monitor-core`** — ingestion target (`POST /v1/events`, `X-Api-Key`).
- **`go-monitor`** — the Go SDK; shares the wire format.
- **`monitor-web`** — consumes this SDK for browser error capture.

## Development

| Command | What it does |
|---|---|
| `npm run check` | `tsc --noEmit` |
| `npm test` | vitest |
| `npm run build` | tsup → `dist/` (CJS + ESM + d.ts) |

Publishing to npm runs the build via `prepublishOnly` and requires 2FA.

## Contributing & further reading

Read **[AGENTS.md](./AGENTS.md)** before working here — it documents the event pipeline,
the exact wire contract (kept in lockstep with `go-monitor` / `monitor-core`), the
config surface, and current known issues (notably Node-runtime caveats).
