# Console Error Handling Recovery Plan

## Goal

Restore a stable admin console experience when backend API handlers fail, especially for non-critical telemetry endpoints such as `/api/metrics/friction-index`.

## Problem

The current console server can leak Bun's HTML error page directly to the frontend when an API handler throws. The dashboard then renders raw HTML inside the shared error slot, which is noisy, misleading, and inconsistent with the project's observability and high-bandwidth UX principles.

## Scope

This plan covers only:

- wrapping console API handler failures in JSON responses,
- making frontend request errors concise and readable,
- and verifying that the `3090` console recovers after a restart.

This plan does not cover:

- redesigning the dashboard bootstrap flow,
- changing loop behavior,
- or broad database-layer refactors beyond the minimum needed for this regression.

## Intended Behavior

1. If a console API route throws, the server must return JSON rather than an HTML fallback page.
2. The frontend must summarize server failures into compact operator-readable text.
3. The dashboard must remain usable even if the friction-index endpoint fails.
4. After restarting the console server, the `3090` admin console should load normally and no longer leak raw HTML into the UI.

## Validation

- Add a server test proving `/api/metrics/friction-index` returns JSON `500` when the underlying DB call throws.
- Add a frontend test proving HTML error bodies are reduced to a compact message instead of being rendered raw.
- Run targeted tests for `src/server.test.ts` and `web/src/App.test.tsx`.
- Run full `bun test` and `bun run typecheck`.
- Restart the console server on `3090` and verify `/api/health`, `/api/status`, and `/api/metrics/friction-index`.
