# Syncro adapter boundary

The official OpenAPI snapshot and inspected routes are in `docs/contracts/`. Browser demos use the typed `src/read-client.ts` adapter for bounded customer/contact/ticket lookups and optional single-attempt test-ticket creation restricted to an explicitly selected customer. Ticket append and production retry/reconciliation remain pending. See `docs/browser-demo-calls.md`.
