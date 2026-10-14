# ChinookIT AI Support Receptionist
## Codex implementation specification — 3CX V20 Update 10 / OpenAI Realtime / Syncro MSP

**Document version:** 1.0  
**Prepared:** October 13, 2026  
**Status:** Build specification; validate against the installed Update 10 build before live deployment  
**Primary deliverable:** A deployable, self-hosted Node.js/TypeScript service with a secured web administration UI, deployed on one Linux VM.

> **Codex: follow this document as implementation requirements, not as an example to improvise from.** Build in phases and prove each phase with automated tests. Do not invent vendor SDK methods, Syncro request fields, Realtime event formats, licensing, or PBX routing features. Inspect the pinned official repositories and live API specifications first. If a requested feature cannot be verified, implement a tested adapter with a clearly reported blocked integration; do not silently fake it.

---

## 1. Objective and scope

Build an inbound AI voice receptionist for **ChinookIT**, an Alberta healthcare-focused MSP. Caller enters the AI flow through 3CX, speaks naturally to an OpenAI Realtime agent, and answers **dynamic follow-up questions** about a technical problem. The agent identifies the clinic and contact, checks for potentially related existing tickets, confirms an accurate summary, and uses a backend tool to create a ticket in Syncro MSP. Caller can ask for a technician; call handling and ticket outcomes must be audited.

**Required for v1:**

1. 3CX V20 Update 10 Programmable Extension via official Call Control SDK/example; run application externally on Ubuntu.
2. OpenAI Realtime bidirectional voice using official 3CX example as the baseline; model and voice configurable.
3. Syncro customer/contact lookup, duplicate-candidate search, ticket creation, ticket note append where supported, and retry/error handling.
4. Natural dialogue, relevant dynamic follow-ups, caller confirmation, responsible priority suggestion, no invented facts.
5. Admin web UI to enter/rotate API credentials and connection settings, edit agent prompt and routing settings, test connections, and see **all conversation history retained by the application** with per-call timeline, transcripts, tool actions, errors, and ticket results.
6. Login protection, role separation, encrypted secrets, redaction, audit trail, retention controls, backup and recovery.
7. First-run setup wizard, Docker Compose deployment or systemd deployment, documentation, tests, synthetic demo mode.

**Explicitly out of scope for v1:** AI troubleshooting that changes computers, privileged access to clinic networks/EMRs, autonomous server restarts, email/calendar integration, patient data processing, outbound sales calls, production SIP/PBX implementation, unbounded automatic dispatch, caller authentication from phone number alone.

**Non-goal:** Do not promise *literally infinite, permanent* retention. The UI must show the full retained history and support paginated search/export; administrators control retention subject to approved company policy. Logs cannot be reconstructed before the app is installed or after approved deletion.

### Definition of done

An external caller choosing AI intake can describe an issue with interruptions and follow-up questions, confirm details, receive a **real Syncro ticket number only after confirmed API success**, and end or transfer safely. An authorized admin can log in, configure secrets without editing YAML, inspect each call's transcript and tool events, search past calls, and diagnose failures. No real secrets appear in browser responses, application logs, transcripts, or exported audit bundles.

---

## 2. Verified reference implementation and documentation

Use official sources as the source of truth:

- 3CX Programmable Extensions: https://www.3cx.com/docs/programmable-extensions/
- 3CX AI providers / OpenAI example setup: https://www.3cx.com/docs/agentic-call-control-ai-providers/
- Official example repository (MIT): https://github.com/3cx/agentic-call-control
- OpenAI-specific example: https://github.com/3cx/agentic-call-control/tree/master/examples/openai-realtime
- 3CX Call Control API: https://www.3cx.com/docs/call-control-api/
- Syncro official OpenAPI UI: https://api-docs.syncromsp.com/
- OpenAI Realtime documentation: https://platform.openai.com/docs/guides/realtime

**Validated architecture:** The 3CX example runs on an external machine, authenticates to the PBX with a Service Principal, receives Call Control events, streams caller audio into OpenAI Realtime and back, and has tools for transfer/drop/MCP integration. Its documented path uses `src/callcontrol/call-store.ts`, `src/providers/openai-realtime.ts`, `src/agent/tool-executor.ts` and YAML agent profiles. PBX audio is converted between 8-kHz and Realtime's audio format by the example. Use these existing utilities; do not build a second audio bridge.

**Preflight vendor verification mandatory:** Validate exact installed 3CX release, Call Control feature/licence entitlement and Service Principal setup, official example commit SHA, Node/Yarn requirements, current model IDs supported by account, Syncro OpenAPI operation schemas and user-account permissions. Record results in `docs/integration-verification.md`. Do not hard-code model names assumed from chat; populate a model selector from supported validated IDs, allowing a manually entered documented model ID with a test.

### Important architecture choice

Create a **monorepo derived from the official example**, with minimal documented upstream modifications, not a rewrite of Call Control. If necessary run a UI/API process and voice worker as two processes/containers **on the same Ubuntu VM**; to operators this is one application. Prefer sharing typed domain services and DB. The 3CX upstream example is a reference, not a guaranteed stable library interface.

---

## 3. Architecture and trust boundaries

```text
Caller -> 3CX SIP trunk / IVR -> Programmable Extension (Service Principal)
                                      |
                                      v
                            Voice Worker (Node/TS)
                            3CX Call Control SDK
                                      |
                               streamed PCM audio
                                      |
                                      v
                             OpenAI Realtime API
                                      |
                           validated local tool calls
                                      |
                                      v
                      ChinookIT Integration Services (Node/TS)
                     - clinic/contact resolver
                     - Syncro API client
                     - ticket orchestrator / job queue
                     - call event logger / transcript store
                     - security/auditing/PII filtering
                                      |
                 +--------------------+-------------------+
                 v                    v                   v
             Syncro API         SQLite/Postgres       Admin Web UI
                                 + encrypted secrets    HTTPS, RBAC
```

**Host:** Ubuntu Server 24.04 LTS or supported newer LTS, recommended starting allocation 2-4 vCPU, 4-8 GB RAM, 40+ GB encrypted persistent storage (increase based on history/recordings). Node.js 20+ per official example; pin a supported maintained version after compatibility testing. Docker Compose recommended. Reverse proxy with valid TLS. Restrict the admin service to LAN/VPN or an identity-aware access layer.

**External connectivity:** The VM connects outbound to PBX HTTPS/FQDN, OpenAI Realtime WebSocket/TLS, and your tenant's Syncro API. Do not expose an unauthenticated tool server to the public internet. Do not put API secrets in the browser, agent instructions, repo, or environment printed by logs.

**Persistent storage:** For prototype, SQLite WAL with one application instance, migrations and backups. For multiple independent workers or growth, PostgreSQL. Database abstraction must support migration without rewriting domain logic. Queue may be DB-backed for v1. Separate `web`, `voice-worker`, and `retry-worker` processes are permitted in one Compose stack. Document transactional boundaries.

---

## 4. Repository layout

```text
chinookit-ai-receptionist/
  apps/
    voice-worker/             # adapted 3CX OpenAI reference; no duplicate SIP stack
    server/                   # REST API, settings, Syncro, persistence, queue
    web/                      # responsive admin UI
  packages/
    shared/                   # types, validation schemas, constants
    syncro/                   # API adapter, mapping, contract tests
    security/                 # encryption, redaction, authentication helpers
    conversation/             # state machine, prompts, summarizer
  db/migrations/
  infra/compose.yaml
  infra/Caddyfile.example
  scripts/bootstrap-admin.ts
  docs/
    integration-verification.md
    deployment.md
    pbx-setup.md
    runbook.md
    privacy-and-retention.md
    operator-guide.md
    upstream-changes.md
    api-contracts.md
  tests/unit/
  tests/integration/
  tests/e2e/
  .env.example
  README.md
```

Keep the actual upstream repository checked in as a clearly documented vendor subtree/fork or pinned dependency as licences permit; maintain a single reproducible version. Add a section listing all changed upstream files and reasons.

---

## 5. 3CX V20 Update 10 implementation

### Provisioning

1. Confirm PBX is V20 Update 10 and Call Control access is licensed/enabled for this installation.
2. Web Client -> **Admin -> Integrations -> API** -> create a **Service Principal**. Example Client ID: `chinook-ai`; enable Call Control API; grant least-needed extension scope; copy generated secret into the web UI.
3. Configure 3CX server FQDN/port and service-principal Client ID/secret in Web UI; test authenticated connection before enabling calls.
4. Dial the Client ID internally for the first smoke test. Only after successful internal testing, route an IVR option or dedicated DID to the programmable extension using PBX routing supported by the deployed build. Preserve "Press 1 for technician; press 2 for AI ticket" as proposed default.
5. Define an approved support queue/extension for transfers and fallback; do not let the AI transfer to arbitrary extensions or external numbers.
6. Test external caller ID (may be unavailable or spoofed), voicemail/fallback, invalid number, agent unavailable, concurrent callers, and 3CX restart.

### Reuse official example

- Mirror/adapt the OpenAI-specific example's `index.ts`, `call-store.ts`, provider bridge, audio utility, tool executor and agent YAML. Check actual code rather than constructing SDK methods from prose.
- Preserve correct V20 Call Control state changes, audio resampling, playback buffering, tool-response flow, interruption/barge-in handling, transport reconnect strategy, and call cleanup.
- Agent is one session per phone call, with immutable call context and unique `call_session_id` separate from PBX participant/call IDs.
- Do not accept new calls until mandatory dependencies and credentials have passed readiness validation; set degraded state and route/fail over according to supported PBX behavior.
- When transfer succeeds, stop AI audio and correctly release AI session resources. Never create ticket twice because of reconnect or duplicate event.

### Call states

`ringing -> accepted -> greeting -> identifying -> collecting -> confirming -> submitting -> completed`

Additional terminal states: `transferred`, `abandoned`, `failed`, `no_ticket`; and intermediate `ticket_pending_retry`, `disconnected`. Implement explicit transition guards and timestamps. Reconcile transitions after process crash.

**Failure condition:** If agent hangs, API fails, or audio cannot establish, log reason and use approved transfer/fallback when possible. Never leave caller in a silent infinite loop.

---

## 6. OpenAI Realtime agent requirements

**Initial model:** administrator-selectable supported Realtime model; benchmark a full and a mini variant on realistic calls. Use the API's documented current identifiers; default may be configured during setup. Do not assume `2.1-mini` is a stable literal ID without checking the model list/account documentation.

**Agent identity:** "Ryan", ChinookIT AI support assistant. Plain Canadian English, supportive, succinct (one question at a time), never pretend to be human, never pretend tools succeeded.

**Default greeting:** "Thanks for calling ChinookIT. I'm Ryan, the AI support assistant. I can help create a support ticket. Please avoid sharing patient information or passwords. What clinic are you calling from?"

**Intake fields (collect only as useful):** clinic, caller name, verified callback number, technical issue, affected software/device, exact error wording, onset, number of users affected, patient-care/clinic-operational impact, previous steps tried, desired callback, contextual notes. Ask dynamically, skip supplied answers, and avoid prolonged interviews. Confirm clinic match explicitly if uncertain.

**Clinical context examples:** EMR unavailable to entire clinic = high/critical operational impact; printer scanning issue = ask whether printing still works, scanning destination/error, impact, printer identification. No diagnosis or promises about technical root cause.

**Safety and privacy:** Never ask for passwords/MFA, patient name, personal health number, DOB or medical record. If caller volunteers such information, redirect and attempt to redact sensitive content in storage, while recognizing redaction is imperfect. No invasive instructions (firewall edits, security disable, server restart, registry edit). Active incident/clinic-wide outage triggers high-priority route or human escalation according to approved rules, rather than unsupervised resolution.

**Tool policy:** The agent receives allowlisted functions, not Syncro credentials. Only backend service may decide customer ID, ticket fields, urgency mapping, or whether a write is allowed. The AI must summarize then obtain an explicit yes before committing. An interruption or hang-up is *not* consent to submit unless operator-configured policy explicitly allows saving a draft only.

### Agent tools (logical contracts; implement exact 3CX example bridging mechanism)

```ts
find_clinic({ name?: string, callerNumber?: string }):
  Promise<{ matches: Array<{ id: string, name: string, confidence: number }>; needsConfirmation: boolean }>
find_contact({ clinicId: string, name?: string, phone?: string }):
  Promise<{ matches: Array<{ id: string, displayName: string }>; needsConfirmation: boolean }>
find_related_tickets({ clinicId: string, summary: string }):
  Promise<{ candidates: Array<{ id: string, title: string, status: string }>; canAppend: boolean }>
prepare_ticket({ clinicId: string, contactId?: string, intake: IntakeFields }):
  Promise<{ draftId: string, spokenSummary: string, validationErrors: string[] }>
submit_ticket({ draftId: string, callerConfirmed: boolean }):
  Promise<{ outcome: 'created'|'already_exists'|'queued'|'failed', ticketId?: string, message: string }>
append_existing_ticket({ ticketId: string, note: string, callerConfirmed: boolean }):
  Promise<{ outcome: 'updated'|'failed', ticketId?: string }>
transfer_to_support({ reason: string }): Promise<{ outcome: 'transferred'|'unavailable'|'failed' }>
```

These are **internal TypeScript contracts, not claims about native 3CX or Syncro API endpoints**. Use Zod/JSON Schema for runtime validation; never trust tool arguments. Confirm actual tool naming/registration conventions from official 3CX examples. Rate-limit each call's tool use. Default `submit_ticket` and `append_existing_ticket` require explicit caller confirmation and a backend-signed draft token. Model-supplied IDs are validated against resolved session customer.

**Example flow:** Caller reports "our Lexmark won't scan" -> AI asks if print works -> caller "yes, scanning says destination unavailable" -> asks who is affected and when it began -> verifies clinic/caller -> reads back summary -> user confirms -> `submit_ticket` -> backend gets genuine Syncro ID -> AI speaks actual ticket ID. No fake ticket numbers.

---

## 7. Syncro MSP adapter

Use `https://<tenant>.syncromsp.com/api/v1` as tenant-scoped API base **after validating tenant host**; docs are at https://api-docs.syncromsp.com/. Syncro identifies API credentials with the logged-in user account; provision dedicated least-privilege account/role if supported, avoid personal owner credentials. The public docs currently state **180 requests/minute per IP**; implement rate limiting below this and exponential backoff for 429s.

### Required functions

- Search customers by phone/name using documented customer endpoints and pagination.
- Search customer contacts; where contact association fields differ, use OpenAPI schema as truth.
- Resolve caller identity only as a suggestion; never assume phone number proves identity.
- List/search open tickets scoped to the correct customer when API permits; present duplicates for decision.
- Create ticket with mapped customer and appropriate contact or caller details; store returned unique ticket identifier, URL if available, API request ID and status.
- Add note/comment to existing ticket using documented endpoint after caller confirms.
- Determine exact accepted status, priority, assigned-user, issue-type and custom-field values from tenant configuration rather than hard-coding invented enums.
- Before submission save immutable draft and idempotency key. Treat uncertain network timeout as **unknown outcome**, reconcile by known marker/customer/time before retry, rather than blindly reposting.

### Required ticket fields

```
Subject: concise AI-generated issue summary
Customer: validated Syncro customer ID
Contact: validated Syncro contact ID where supported
Description:
  Caller and callback details
  Affected location/clinic
  Problem description and exact error text
  First noticed and scope/impact
  Relevant previous troubleshooting
  AI-collected context and uncertainties
  Source: ChinookIT AI Phone Intake
  Internal call reference: <UUID>
Priority: mapped by backend rules and supported tenant values
```

Never include raw transcript by default in a ticket; admin may enable a sanitized excerpt after privacy review. Ticket write request and response must be sanitized before logging; do not store Syncro authorization header. A missing clinic match must not create under the wrong clinic; instead request clarification, offer transfer, or create a non-Syncro pending-review record in application.

### API contract tests

Generate a typed adapter from the CURRENT Swagger/OpenAPI where feasible. Keep mock fixtures for 200, 401, 403, 404, 409, 422, 429, 500 and malformed/empty responses. Validate exact request and response shape in staging against a test Syncro customer and test ticket. Allow dry-run mode with no write permissions.

---

## 8. Web administration UI — REQUIRED v1

Build a simple, functional, responsive browser UI, branded "ChinookIT AI Receptionist". Framework recommendation: React + TypeScript + Vite, served behind same HTTPS domain as backend. No excessive UI framework or marketing pages. Accessible keyboard navigation and clear status labels.

### Authentication and roles

- Mandatory first-run account setup with strong password; Argon2id password hashing; secure HttpOnly SameSite cookies, CSRF protections, login throttling, session expiry, password-change flow, no default password.
- Roles: `admin` (settings/secrets, all calls, users, exports), `support` (call/transcript/ticket view without raw secrets), `auditor` (read-only history). For v1 can ship admin + support if auditor explicitly deferred in UI, but implement role design now.
- Require fresh reauthentication for credential change, destructive operations and full bulk export.
- Prefer LAN/VPN only, optional external SSO in later phase. Audit login, failed login, key rotation, export, setting change, transcript viewing and deletion.

### Pages and features

**A. Overview / dashboard**
- Cards: service health, PBX connectivity, OpenAI connectivity, Syncro connectivity; concurrent/live calls; tickets created, transfers, failures and pending retries; counts for 24h/7d/30d.
- Recent calls table with date/time (America/Edmonton display), clinic, caller (masked by default for nonadmin), duration, outcome and ticket #.
- Alerts: degraded PBX connection, OpenAI authorization error, Syncro rate limiting, background queue backlog.

**B. Connections and API keys**
- Form: 3CX PBX HTTPS FQDN, Service Principal Client ID, secret; OpenAI API key, model, voice, VAD/transcription choice; Syncro tenant subdomain and API key.
- Password-like fields mask stored values; display `Configured — last updated …` and last four chars only if safe. **Never return decrypted keys to browser or display them after save.** Blank means unchanged; explicit rotate/remove workflow.
- Buttons: `Test 3CX`, `Test OpenAI`, `Test Syncro`, `Save`, `Revert`. Backend tests must call safe read-only capability where supported, show specific sanitized errors and time without exposing credentials.
- Apply validation before committing; save revision and audit actor/IP/timestamp, rotate live connections with graceful draining (do not terminate an active call unexpectedly). Support secret rekey via admin action.
- Additional settings: support transfer destination (allowlisted), default clinic resolution behavior, hours/fallback routing and dry-run/demo mode.

**C. Conversations / complete retained call history**
- All retained sessions, including completed, abandoned, transferred, failed, no-ticket and test calls; infinite pagination via server-side cursor, filters for date range, clinic, caller number, ticket number, outcome, sentiment not required, duration, text search across redacted transcripts.
- Columns: start/end time, call direction, caller ANI masked, resolved clinic, contact, outcome, ticket number/link, duration, model, transcript completeness indicator, recording availability, errors.
- Clicking session opens a **chronological timeline** of AI/user turns, transcript segments (speaker + time), tool calls and sanitized inputs/outputs, backend validations, Syncro request result, call state transitions, transfers and hang-up reason, latencies, retries and errors. Group noisy telemetry behind expandable `Technical events`.
- Full-text search across safely redacted transcript text. Highlight matches; filter failed/no-ticket sessions. Export one sanitized conversation as JSON, TXT or CSV (user-confirmed). Admin-only bulk export; audit each export.
- Retain failures even if no speech transcript exists; show `Transcript unavailable` honestly. Transcript is not guaranteed to be a perfect verbatim record; annotate AI/caller transcription confidence if exposed by provider.
- If audio recording is enabled separately, show playback ONLY when consent, encryption, storage and retention requirements are approved and implemented; **off by default**. Transcripts/logs must not be treated as proof of patient consent.

**D. Conversation detail view**
- Header: session ID, date, caller, duration, tenant clinic, transcript status, ticket result, links to Syncro ticket.
- Tab/sections: `Conversation`, `Ticket`, `Technical events`, `Audit`. Quick action: retry failed ticket after safe review, download sanitized export, copy incident ID. Do NOT allow modifying historical immutable events.
- Human-readable diagnostic panel for disconnected calls; preserve call IDs and correlation IDs without secrets.

**E. AI agent settings**
- Editable, versioned system prompt in a guarded editor; test prompt preview and revert version; config for welcome script, company name, agent name, max question budget, ask-for-confirmation toggle (do not allow disabling without admin warning), escalation keywords, severity policy.
- Model/voice selectors with freeform validated ID; safe `Test voice greeting` action that cannot dial external numbers.
- Only apply new prompt to new calls; preserve `prompt_version` in each session for auditability.

**F. Admin users and maintenance**
- User list/invite or manual account creation, role assignment, account disable, password reset controlled by admin.
- Storage/retention settings, export backup, verification status, recent software version/commit, database health, job queue and retention task runs.
- No `Delete all logs` one-click button. Require deliberate confirmation, authorization and durable audit record for purges.

### UI acceptance tests

- From a new install, admin can enter all three providers' settings in UI, save, reopen and observe masked settings; no .env editing beyond master encryption key/bootstrap.
- Admin can see all persisted calls, including failed and aborted sessions; can filter, full-text search redacted transcript, inspect timeline and link ticket.
- Support user cannot read/rotate API keys, export full archives or delete conversations.
- No API response, HTML source, JS bundle, browser storage or client-side telemetry contains secret value.
- All list/search endpoints use pagination and authorization; no uncontrolled full-database download on page load.

---

## 9. Logging, transcript capture and retention

**Must implement:** a durable event store that logs every session from its creation, not just tickets or successful calls. All timestamped events must reference `session_id`, `call_id` (if available), `event_id`, event `type`, `sequence`, `actor`, severity, and schema version.

Event types: `call.received`, `call.accepted`, `call.ended`, `transcript.user.final`, `transcript.assistant.final`, `tool.requested`, `tool.completed`, `tool.failed`, `clinic.matched`, `ticket.draft`, `ticket.submitted`, `ticket.created`, `ticket.unknown_outcome`, `ticket.failed`, `call.transferred`, `provider.error`, `retry.scheduled`, `retry.completed`, `settings.changed` (separate security audit table).

**Transcript implementation:** Inspect actual OpenAI Realtime events in the pinned bridge. Capture final user-input transcription events and assistant output text/transcription events where provided. If a spoken assistant turn lacks a transcript, mark that turn unavailable rather than fabricating speech. Avoid storing streaming deltas redundantly; construct finalized turns, preserving interruption/cancellation markers and partial/incomplete state when necessary. Prefer provider transcription path validated in reference example; expose configurable transcription-on/off if business policy requires it.

**Retention policy:** default example: 90 days content retention and 365 days limited operational audit metadata, **pending ChinookIT legal/privacy policy approval**. Allow configured retention (e.g., 30/90/180/365 days or approved indefinite retention with explicit warning and operator-approved lawful basis). Provide purge preview, background purge job, deletion audit metadata and backup lifecycle; backups must follow equivalent expiration. Never claim deleted data has been erased from third-party providers. The phrase "all conversations ever had" means every session *since logging was enabled and still retained under policy*, searchable without artificial UI limit, not limitless retention by default.

**Privacy controls:** redact passwords, API keys, MFA codes and obvious patient identifiers from transcripts/log payloads where detectable, **before indexing and storing**; provide explicit indication automated redaction is not perfect. Data minimization and restricted access matter because calls may concern clinical systems. Raw audio recording disabled by default; recording, if added, is a distinct opt-in setting gated by approved policy/consent and encrypted object storage. Admin must be able to disable transcript content capture while retaining minimum operational metadata, if policy demands.

**Performance:** asynchronous writes, bounded queues, crash-safe storage and explicit backpressure. Log errors without leaking payloads/secrets. Maintain structured JSON diagnostic logs with rotation independent from conversation DB. Avoid storing unredacted full OpenAI session messages or complete raw HTTP body debug dumps.

---

## 10. Suggested database schema

Use migrations with indexes, referential integrity and encrypted secrets; field names may be refined by implementation.

```text
users(id, email, password_hash, role, disabled_at, created_at, last_login_at)
sessions(id, pbx_call_id, pbx_participant_id, caller_number_masked,
  caller_number_ciphertext?, direction, started_at, ended_at, duration_ms,
  state, outcome, clinic_id, clinic_name, contact_id, contact_name,
  prompt_version_id, realtime_model, transcript_status, ticket_id,
  ticket_url, error_code, created_at, updated_at)
conversation_turns(id, session_id, turn_index, speaker, started_at, ended_at,
  text_redacted, is_final, is_interrupted, source, transcription_status)
call_events(id, session_id, sequence, event_type, event_time, severity,
  public_summary, sanitized_details_json, correlation_id)
ticket_drafts(id, session_id, customer_id, contact_id, content_json,
  caller_confirmed_at, status, idempotency_key, created_at, updated_at)
ticket_jobs(id, draft_id, attempt_count, next_attempt_at, state,
  syncro_ticket_id, last_error_code, created_at, updated_at)
credentials(id, provider, encrypted_blob, key_version, updated_at, updated_by)
app_settings(key, safe_json_value, updated_at, updated_by)
prompt_versions(id, name, content, created_by, created_at, active_from)
audit_events(id, actor_user_id, operation, target_type, target_id,
  occurred_at, source_ip, sanitized_metadata_json)
retention_runs(id, started_at, finished_at, policy_version, deleted_counts_json)
```

Index session time/outcome/clinic/ticket, transcript full-text (FTS5 for SQLite or Postgres full-text), and `call_events(session_id,sequence)`. `ticket_drafts.idempotency_key` unique; ensure event ingestion is idempotent across reconnects. Source caller number should be stored encrypted only if needed for callback, masked for default display.

---

## 11. Secrets, deployment security, and data protection

- Provide a `MASTER_ENCRYPTION_KEY` via file or environment bootstrap **outside** web UI, protected by file permissions/host secret manager, plus secure backup strategy; use modern authenticated encryption (e.g. AES-256-GCM or libsodium sealed boxes). Per-secret nonce, version and authenticated associated data. Never include master key in DB backups.
- Encrypt provider keys at rest, decrypt only in backend/voice worker memory as needed; rotate and audit. Never write credentials into YAML or Compose logs. Protect Corepack/Yarn lockfile and dependency chain.
- Admin web HTTP service bound to 127.0.0.1 or private interface by default; HTTPS reverse proxy or VPN access. Strong headers, same-origin policy, CSRF defense, strict input validation, no CORS wildcard, session cookies only.
- Principle of least privilege for Service Principal and Syncro token; network egress ACL where practical.
- Non-root containers, read-only filesystem where feasible, writable volumes only where needed, health checks, resource limits, log rotation, automatic restart. Automated security updates with maintenance plan.
- All admin users and support staff must understand transcripts can contain sensitive information. Review Alberta privacy rules/contractual requirements before turning on production capture or external processing. Confirm where data is processed/stored and provider-specific contractual obligations; do not assume Canadian data residency.
- Define backup restore test, disaster recovery plan, incident response, and process to revoke all three credentials quickly.

---

## 12. Application API design (internal; not vendor routes)

Protect every endpoint with session auth/role checks. Suggested routes:

```text
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me
GET    /api/health/live             # minimal nonsecret output
GET    /api/health/ready            # internal only / guarded detail
GET    /api/dashboard/metrics
GET    /api/settings/connections    # masked metadata only
PUT    /api/settings/connections    # admin; secret field write-only
POST   /api/settings/test/:provider # admin, read-only safe provider check
GET    /api/settings/agent
PUT    /api/settings/agent          # admin, versioned
GET    /api/conversations?cursor=&q=&from=&to=&outcome=&clinic=&ticket=
GET    /api/conversations/:id
GET    /api/conversations/:id/events?cursor=
GET    /api/conversations/:id/export?format=json|txt|csv
GET    /api/tickets/pending
POST   /api/tickets/:jobId/retry    # admin, server-side verified
GET    /api/admin/users
POST   /api/admin/users
GET    /api/admin/audit?cursor=
GET    /api/admin/retention
PUT    /api/admin/retention
```

Return consistent typed error envelopes with a correlation ID; never put raw upstream error bodies containing secrets in response. Validate all IDs, cursor bounds, filters, date parsing, exports and role permissions server-side. Set default page limit 50, maximum 200; use stable order, not offset pagination for large history. Provide OpenAPI for these app routes.

---

## 13. Syncro ticket orchestration and reliability

**Exactly-once intent / at-least-once processing:** Client creates one immutable draft, caller confirms, server atomically marks submission eligibility and creates a persisted job. Multiple Realtime tool invocations or reconnects reuse the draft's idempotency key. Since Syncro may not offer a generic idempotency endpoint, reconciliation must inspect known marker/ticket list if POST times out. Only one job can own a draft. No blindly repeating POST after an ambiguous timeout.

**Success:** Save authoritative Syncro ID and link, log `ticket.created`, send truthful confirmation.  
**Definitive validation failure:** Tell caller submission could not be completed, offer technician transfer; retain failed draft privately.  
**Transient Syncro failure:** Retain job for safe retry; tell caller request was recorded locally but **not yet confirmed in Syncro**; escalate for human monitoring, not claim a real ticket.  
**Caller hangs up:** Save call log and draft (if any). Never auto-create without caller confirmation unless separately configured and explicitly tested; admin receives review alert.  
**OpenAI fails midcall:** Graceful transfer if possible; persisted call record marked failed; no fabricated transcript.  
**3CX fails:** Reconnect with bounded retries; health degraded, admin notified, PBX fallback route documented and tested.  
**Support queue unavailable:** Offer ordinary voicemail/human callback path supported by PBX; document exact routing behavior for tested build.

---

## 14. Implementation phases and mandatory tests

### Phase 0 — Discovery and preflight

- Pin official 3CX example commit, inspect current code, release notes and exact dependency versions.
- Confirm 3CX Update 10 licensing, API scope, routing support on actual PBX.
- Confirm Syncro OpenAPI endpoint field names and real tenant options via read-only access.
- Document model availability and Realtime event shape.
- Deliver `integration-verification.md` and machine-readable configuration schema.

**Gate:** No unverified guessed endpoints in production code.

### Phase 1 — Local foundation + admin UI

- Set up monorepo, typed config, Docker Compose, SQLite/Postgres migrations, backend, web app, secure admin setup.
- Build Connections page with write-only encrypted credential management, safe connection test, masked status.
- Build Conversations view against realistic seeded sample events; search, filters, cursor pagination, detail timeline, export, roles.

**Gate:** UI works offline in demo mode; secrets cannot be recovered via browser endpoints.

### Phase 2 — 3CX + Realtime voice

- Integrate/pin official OpenAI example, use Programmable Extension, test internal call and real audio round trip.
- Instrument lifecycle and exact transcript events into event store.
- Validate barge-in, early hang-up, simultaneous calls, reconnection, failure paths and transfer.

**Gate:** Call history shows all test calls, accurate state transitions, available transcripts and failures.

### Phase 3 — Syncro integration + tool calling

- Typed Syncro adapter, rate limit/backoff, customer/contact resolver, ticket drafts, confirmation and create/append flows, duplicate detection, retry safety.
- Register only scoped tools with Realtime bridge; secure customer binding and action permissions.

**Gate:** Synthetic intake from PBX creates one ticket in test Syncro tenant and logs authoritative ticket ID; deliberate 429/timeouts do not make duplicates.

### Phase 4 — Production hardening

- RBAC, logging redaction tests, transcript retention, admin audit, encryption rotation, backup/restore, alerting, documented deployment and maintenance, failover tests.
- Security/privacy review and pilot with staff only; do not start with real patient details. Obtain company sign-off for recording/transcript retention.

**Gate:** All acceptance criteria below, documented manual verification evidence, rollback plan.

### Automated tests

- Unit: intake validation, clinic ambiguity, severity mapping, backend guard rails, tool idempotency, ticket formatting, encryption and redaction.
- Contract: mocked 3CX call events, current OpenAI Realtime events, Syncro OpenAPI routes; schema fixtures versioned.
- Integration: local DB jobs, reconnect, duplicate tool invocation, dropped session, Syncro retry and unknown-outcome reconcile, rejected secrets.
- E2E browser: first-admin setup, credentials form, failed key test, logs search, ticket detail, role restrictions, reauth, export audit, pagination.
- Voice simulation: clinic-wide outage, single-user printer, EMR login, caller changes story, rambling caller, interruption, unclear clinic, patient identifier, password disclosure, caller refuses confirmation, human request, transfer failure, multi-issue call.
- Load: 5+ simultaneous calls (or within licensed SC limit), log burst, rate-limited Syncro, restart during ticket submission.

---

## 15. Deliverables Codex must produce

- Fully functioning runnable repository with pinned lockfiles, MIT attribution to upstream and clear upstream modifications.
- Docker Compose deployment and `.env.example` containing **no actual secrets**; installation and backup/restore commands.
- Responsive admin UI with Connections, Overview, Conversations, Conversation Detail, Agent Settings, Users, Maintenance.
- Secure credential encryption/rotation and first-run authentication.
- Working 3CX V20 Update 10 Programmable Extension based on official example; OpenAI Realtime connected; valid transfers or explicitly documented limitations verified on PBX.
- Tested Syncro integration with exact API mapping; no hardcoded imaginary fields.
- Conversation event store, redacted transcript capture, searchable complete retained history, tool/ticket logs, configurable retention.
- Working test/dry-run mode for development without dialing external contacts or writing real tickets.
- Automated test suite, API schema, build/lint/test scripts, diagnostics and operating runbook.
- `docs/acceptance-report.md` listing every requirement PASS/FAIL/BLOCKED with evidence and any external prerequisites.

### Acceptance criteria checklist

- [ ] Clean deploy on Ubuntu VM with documented setup.
- [ ] 3CX Service Principal authenticates; internal dial connects to AI on verified Update 10.
- [ ] A caller hears a voice greeting, interrupts, and receives coherent contextual follow-ups.
- [ ] AI handles clinic ambiguity and verifies clinic before any Syncro write.
- [ ] Every received call has a session record even if abandoned/errored.
- [ ] Finalized available user/assistant transcript turns are searchable by admin.
- [ ] Tool requests, responses (sanitized), error reasons, and ticket status appear in per-call timeline.
- [ ] Admin enters API keys through UI and can test providers; no key exposed after save.
- [ ] Support role can view history but cannot reveal or change keys.
- [ ] Real Syncro ticket created once after confirmation and ticket number accurately spoken.
- [ ] Existing-ticket append is scoped to customer, requires confirmation and is audited.
- [ ] Transient failures queue/reconcile safely and never generate accidental duplicate tickets.
- [ ] Real human transfer and fallback routes verified end-to-end.
- [ ] Patient/security information handling and configurable retention reviewed and tested.
- [ ] Backup and restore recovery verified.
- [ ] Admin can access historical records within approved retention and export sanitized results.

---

## 16. Copy/paste task for Codex (use with this specification)

> Implement the attached `ChinookIT_AI_Receptionist_Codex_Spec.md` as a working production-oriented monorepo. Start by cloning and inspecting the official `3cx/agentic-call-control` OpenAI example, pin a commit SHA, check 3CX V20 Update 10 service-principal and Call Control behavior, and consult the official Syncro OpenAPI schema. Do not invent upstream method names or payload fields. Implement the admin UI in v1, including write-only encrypted API key management and exhaustive searchable **retained** conversation history with redacted transcripts and timeline logs. Work through phases 0–4; maintain a task checklist and commit tested increments. Use mocks/dry-run mode when live credentials or PBX access are missing. In documentation and test reports, explicitly distinguish working code, mocked code, and external integrations blocked until real credentials/PBX are supplied. Do not mark a live integration passed without a real test. Preserve upstream licensing, implement appropriate security/privacy controls, and produce the deployment/runbook and acceptance report.

---

## 17. Source verification notes

This document is based on the official 3CX Programmable Extensions documentation and example repository, official Syncro API documentation, and OpenAI Realtime guidance as available October 13, 2026. **Technical details that must be revalidated by Codex:** current 3CX Update 10 production status/entitlement, 3CX SDK/event structures, OpenAI model availability/event schema, Syncro request fields and enum values, licensing, and tenant-specific configuration. No source guarantees that every customer's tenant has identical permissions or that every setting described can be applied without a service restart.

