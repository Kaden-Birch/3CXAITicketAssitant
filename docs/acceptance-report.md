# Acceptance report

Milestone: Phase 0 source discovery and Phase 1 local foundation. Date: October 13, 2026. This is **not** a production completion report. The assistant name is Ryan and the PBX target is 3CX V20 Update 10.

## Validation evidence

- `npm run build`: TypeScript checking and Vite production build pass.
- `npm run lint`: formatting check passes.
- `npm test`: 15 backend/security/contract/persistence tests pass locally. Tests include bootstrap closure, encrypted write-only settings, CSRF/origin checks, support-role restrictions, full history pagination/search, historical prompt binding, demo isolation, mocked read checks, redaction, encryption tamper rejection and database reopen.
- Node 24 runtime: all 15 backend tests pass under Node 24.21.0.
- `npm run test:e2e`: isolated Chromium workflow covers first-admin setup, credential masking, connection-test status, history search/pagination, timeline, logout, switching to support and mobile width. The final workflow passed locally (one end-to-end scenario).
- `docker compose -f infra/compose.yaml config --quiet`: syntax/configuration check passes. Build/run is blocked because the local Docker daemon is unavailable.
- Word specification: two Alex→Ryan replacements; all other archive entry contents preserved. Rendered 17 pages and reviewed the changed identity/greeting page and page contact sheets.

Mocked provider checks verify request scoping and response/error sanitization. They do not establish tenant/account access. Synthetic ticket IDs are never linked to or represented as real Syncro tickets. No live PBX, Realtime voice or Syncro write was attempted.

## Specification acceptance criteria

| Requirement | Status | Evidence / remaining work |
| --- | --- | --- |
| Clean Ubuntu deploy | BLOCKED | Compose scaffold and config check; target VM build/run pending |
| Service Principal authentication and internal Update 10 dial | BLOCKED | PBX origin, licence entitlement and scope unavailable; worker not wired |
| Voice greeting, interruption and contextual follow-ups | BLOCKED | Pinned upstream inspected; internal audio test pending |
| Clinic ambiguity and validation before Syncro write | BLOCKED | Domain resolver/tools planned for Phase 3; no writes exposed |
| Every received live call has a session record | BLOCKED | Durable storage and demo outcomes implemented; live lifecycle hooks pending |
| Finalized available transcript search | PARTIAL | Redacted seeded transcript FTS and cursor search pass; real event capture pending |
| Tool/ticket/error timeline | PARTIAL | Synthetic per-call event timeline works; live tools not registered |
| UI credentials and provider checks without exposing keys | PARTIAL | Encryption/masked responses pass; OpenAI/Syncro read checks mocked; PBX check explicitly blocked |
| Support role cannot reveal/change credentials | PASS | Backend authorization and browser navigation/export restrictions verified |
| One real Syncro ticket after confirmed intake | BLOCKED | Draft orchestration, confirmation tokens and staging write tests pending |
| Existing-ticket append scoped and confirmed | BLOCKED | Exact API route inspected; scoped tool implementation pending |
| Safe transient retries and unknown-outcome reconciliation | BLOCKED | Jobs/draft tables exist; retry worker and reconciliation not implemented |
| Human transfer and fallback verified end-to-end | BLOCKED | Approved destination and PBX test required |
| Privacy handling and configurable retention | PARTIAL | Redaction utility and no raw recording; live ingestion, retention jobs and company review pending |
| Backup/restore verified | BLOCKED | Deployment cautions documented; restore proof pending |
| Complete retained history and sanitized export | PARTIAL | All 75 synthetic records reachable by pagination, JSON exports audited; approved retention and large streaming exports pending |

## Current limits

- The PBX voice-worker remains an integration boundary. Browser calls now use the shared Syncro/intake adapter described in the browser demo extension below.
- PBX checks stay blocked. Model/customer read access never proves voice or ticket-write capability.
- SQLite persistence is implemented; PostgreSQL abstraction/migration and multi-worker concurrency are not yet implemented.
- Export is bounded to 10000 turns and 10000 events per call. User listing is capped at 200 accounts. Add streaming export/account pagination before larger deployments.
- API key replacement is audited. Master-key rotation, recent-password reauthentication for sensitive operations, disabling/resetting users and stronger session lifecycle controls remain Phase 4 work.
- Audio playback, voice-greeting testing, prompt revert UI, retention purge/preview, backup export, alerts and usage metrics require later phases.
- Provider error bodies are discarded; correlation IDs and safe status codes are available, but full rotating diagnostic logging is still planned.
- No production data processing or retention policy has been approved in this session.

See `build-checklist.md` for the next gates and `integration-verification.md` for nonsecret prerequisites.

## Browser demo extension

Added a server-controlled WebRTC demo-call screen with saved agent settings, microphone mute/end, redacted history and shared Syncro/intake tools. Preview-only submission is the default. An explicitly selected real-test mode restricts writes to the supplied customer ID, labels the ticket, verifies a new spoken confirmation, and guards duplicate/uncertain submissions.

22 backend tests and two browser workflows cover provider mocks, secret boundaries, transcript deduplication, safe preview, customer scope, one confirmed real write, rejected/malformed/time-out writes, UI mode gates and media cleanup. Live OpenAI audio, real account permissions and actual ticket creation remain unverified; no real call or ticket was made during implementation. The PBX and production hardening acceptance gates remain unchanged.


## Conversation accuracy and confidentiality update

The latest browser-call behavior supersedes the earlier broad customer/contact/open-ticket lookup tools. Only one conservatively matched clinic name can be returned; customer IDs stay server-side. Partial intake updates preserve other facts, clear changed confirmations, retain original callback values plus E.164, preserve device identifiers and reject unsupported values. Incomplete first/last names and seven-digit numbers require clarification. New final spoken confirmation still gates submission and unknown writes never retry.

Semantic VAD defaults to Low; mandatory continuity rules apply even with existing custom prompts. Server greeting activation is idempotent. Cancelled/truncated assistant text is withheld from searchable history, and cancelled tool responses do not launch tools. Agent settings now expose VAD, interruption, ticket creation, retention and diagnostic logging. Ended history expires on the configured schedule; uncertain/failed submissions are exempt for review.

Automated provider/media tests cover these boundaries. Natural speech quality, ASR uncertainty, real OpenAI/Syncro account calls and 3CX audio routing are not established by mocks. The production PBX worker remains unimplemented. See [detailed report](conversation-accuracy-report.md).
