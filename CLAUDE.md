# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run buy:glm-coding       # Run the CLI checkout
npm run ui                   # Start the local web UI on port 3000
npm test                     # Run all tests (Node.js built-in test runner)
node --test test/url.test.js # Run a single test file
npm run install:browsers     # Install Chromium for Playwright
npm run setup                # Install deps + browsers
```

Set `GLM_RETRY_INTERVAL_MS` to override the retry interval (default 500ms). Set `GLM_HEADLESS=1` to run the browser headless.

## Architecture

This is a Node.js ESM CLI (`"type": "module"`) that uses Playwright to automate creating an unpaid `Pro` monthly-recurring checkout link on `bigmodel.cn/glm-coding`. It opens a browser shortly before 10:00 UTC+8 and retries the checkout action during a 10:00-10:05 window.

### Module dependency graph (top-down)

```
cli.js ──► scheduler.js ──► browser-flow.js ──► payload.js, url.js, time.js
                │
ui-server.js ──► task-manager.js ──► scheduler.js, browser-flow.js
```

- **`src/constants.js`** — The single source of truth: GLM Coding URL, plan/billing values, window time, storage path, and the `STATUSES` enum. Imported by almost every module.
- **`src/url.js`** — URL safety checks. Only `bigmodel.cn` and `www.bigmodel.cn` over HTTPS are allowed. `looksLikeCheckoutUrl` additionally checks for checkout-related path segments.
- **`src/payload.js`** — Recurses through API response JSON to find checkout URLs and order IDs. `classifyText` detects out-of-stock and login-required via regex.
- **`src/browser-flow.js`** — Core Playwright automation. On first run, opens a visible browser for manual login and saves `storageState` to `.auth/glm-coding/storageState.json`. Subsequent runs reuse that state (headless or visible). The main loop: load page → choose the target billing cycle → wait for 10:00 if early → inspect the selected Lite/Pro/Max card → click only the selected target's action button → capture checkout URLs from network responses or page links. Supports `AbortController` signals and `onEvent` callbacks.
- **`src/scheduler.js`** — Calculates the next 10:00-10:05 window. Passes `startAt`/`stopAt` to `browser-flow.js`'s `runFastClickCheckout`. Resolves `GLM_RETRY_INTERVAL_MS` from env.
- **`src/result.js`** — Factory functions for the JSON result shape (status, plan, billing, checkoutUrl, optional orderId). `printJson` writes to stdout.
- **`src/cli.js`** — Entry point. Calls `runScheduledCheckout`, prints the JSON result to stdout, exits 0 on success / 1 on failure.
- **`src/task-manager.js`** — `CheckoutTaskManager` class wrapping `runFastClickCheckout` with start/stop lifecycle, internal status tracking, and `AbortController` integration. Used by the UI server.
- **`src/ui-server.js`** — Zero-dependency HTTP server serving a single HTML page and JSON API endpoints (`/api/defaults`, `/api/status`, `/api/start`, `/api/stop`). Runs on `127.0.0.1:3000` by default (configurable via `GLM_UI_HOST`/`GLM_UI_PORT`).

### Result JSON shape

Success: `{ status: "checkout_ready", plan: "lite" | "pro" | "max", billing: "monthly_recurring" | "quarterly_recurring" | "yearly_recurring", checkoutUrl: "...", orderId?: "..." }`

Failure statuses: `login_required`, `out_of_stock`, `plan_not_found`, `button_never_enabled`, `checkout_not_created`, `contract_changed`.

### Auth storage

Login state persists in `.auth/glm-coding/storageState.json` (gitignored). If the file doesn't exist, the browser opens visibly for manual login; once saved, subsequent runs can run headless (`GLM_HEADLESS=1`).

### Tests

Tests use `node:assert/strict` and `node:test` (no external test framework). Tests are in `test/` and mirror the `src/` module names. Tests are pure unit tests — they never launch a real browser. `scheduler.test.js` and `task-manager.test.js` inject fake `runCheckout` and `now()` functions to test scheduling logic deterministically.
