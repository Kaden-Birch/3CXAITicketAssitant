# Build checklist

## Phase 0 Discovery

- [x] Clone and inspect official 3CX OpenAI example; pin upstream commit and preserve its lockfile.
- [x] Read official Programmable Extensions/provider documentation for the Update 10 target.
- [x] Save and inspect official Syncro OpenAPI contracts; record exact ticket/comment fields.
- [x] Review OpenAI conversation documentation and inspect bridge event names.
- [x] Produce integration verification and machine-readable configuration schema.
- [ ] Verify actual PBX licence/build, routing and Service Principal scope.
- [ ] Verify account model access, tenant fields and permissions with dedicated credentials.

## Phase 1 Local foundation

- [x] TypeScript workspaces, backend, React admin UI and SQLite migrations.
- [x] First-admin setup, Argon2id, session cookies, CSRF, rate limits and admin/support roles.
- [x] Write-only encrypted provider settings and masked connection status.
- [x] Safe demo checks; bounded non-demo read-access checks for OpenAI/Syncro.
- [x] Seed all synthetic call outcomes, full-text transcript search, filters, cursor pagination, timeline and audited JSON export.
- [x] Versioned Ryan name/greeting/prompt and mandatory confirmation setting.
- [x] Unit/integration/contract and isolated browser workflow tests.
- [x] Compose/reverse-proxy scaffolding and setup/operator documentation.
- [ ] Verify Compose build/run on the Ubuntu target (Docker daemon unavailable locally).
- [ ] PBX connection test through the adapted voice worker (Phase 2 dependency).

## Phase 2 Voice

- [ ] Adapt upstream config loading and logging, retaining its single audio bridge.
- [ ] Persist every received call before acceptance; capture available finalized transcript events.
- [ ] Internal call with greeting, interruptions, hang-up, simultaneous calls and reconnect.
- [ ] Verify allowlisted technician transfer and supported PBX fallback.

## Phase 3 Ticket tools

- [ ] Typed Syncro adapter, customer/contact resolution and duplicate search.
- [ ] Immutable signed drafts, explicit caller confirmation, durable jobs and exactly-once intent.
- [ ] Create/append staging tests, 429 backoff, unknown-outcome reconciliation and human review.

## Phase 4 Production hardening

- [ ] Retention purge jobs/policy approval, key rotation, user disabling/reset and session lifecycle hardening.
- [ ] Backup/restore proof, incident alerts and operational recovery.
- [ ] Security/privacy review, load/failover evidence, staff pilot and rollback sign-off.
