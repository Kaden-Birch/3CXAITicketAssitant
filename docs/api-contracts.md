# Application API contracts

`docs/contracts/app.openapi.json` documents the implemented routes and request schemas; regenerate with `npm run schema`. Internal API routes are distinct from vendor routes. All responses use `Cache-Control: no-store`. Errors have `{error:{code,correlationId}}`, with no raw provider payload or validation input. Unknown API routes return 404.

## Access and writes

Authenticated routes require the `chinook_session` HttpOnly cookie. Admin-only routes reject support accounts. Every non-GET request requires an exact `Origin: APP_ORIGIN`; authenticated writes also require `X-CSRF-Token` from `/api/auth/me`. Setup requires the host-local bootstrap token and is permanently closed after creating the first user. The UI keeps its CSRF token in memory, never in localStorage.

Connection writes accept provider-specific settings and an optional `secret`; omitted secrets preserve encrypted values. Connection reads return `{connections:[{provider,settings,secretConfigured,updatedAt,test}]}`. No credential value or suffix is returned. Tests return `{status,message,testedAt,models?}`. A `read_access_verified` result is scoped to model/customer listing, not a working voice session or ticket write.

Agent reads return current settings with `versionId`. Agent writes create a new immutable version and return `{ok,versionId}`. Confirmation must remain true. Historical call detail resolves the original prompt version.

## History

`GET /api/conversations` accepts `q`, exact `clinic`, `outcome`, `ticket`, ISO timestamp `from`/`to`, opaque `cursor` and bounded `limit` (50 default, 200 maximum). Result: `{items,nextCursor}`. Stable descending timestamp/UUID ordering prevents duplicates across pages for the static retained result set. Search covers summaries, clinic names and redacted full-text transcript phrases. Inserts during navigation do not rewrite previous pages.

Call detail returns `{session,turns,agent,truncated}` with an initial 200-turn page. Further turns/events use `after` index/sequence and `limit`, returning `{items,nextAfter}` with null at the end. These records are read-only. No mutation endpoint exists for historical events. Sanitized JSON export is admin-only and audited; the current synchronous export is limited to 10000 turns and must be replaced with a bounded streaming export before very large live sessions are supported.

Security audit pagination returns `{items,nextCursor}` and accepts `after`/`limit`. User listings return the first 200 accounts; larger deployments need account pagination before expansion. Stored passwords and session token hashes are never returned.

## Planned integrations

No PBX ingestion route, external tool server, retention delete endpoint or backup export is exposed. Browser demos have scoped server-controlled tools; see browser-demo-calls.md. Phase 2/3 will add those through tested internal services and scoped worker access.

## Browser-call routes

Admin-only routes use the same cookie, origin and CSRF checks: `GET /api/demo-calls/status`, `POST /api/demo-calls` with `{sdp,writeMode?,testCustomerId?}`, `GET /api/demo-calls/:id`, and POST `activate`, `heartbeat`, `end` under that call. Call IDs are bound to the starting admin. Start returns only the local ID, SDP answer and safe mode/version metadata. Preview is the default; live_test requires a permitted customer ID and a new spoken confirmation before the backend write. Transcripts, events and draft results are available from the snapshot and retained history.
