# Integration verification

Verification date: October 13, 2026. Status: repository and documentation discovery complete; installed-system and account checks remain blocked. The user selected **3CX V20 Update 10** and **Ryan** as the assistant name. A target release is not evidence of an installed build, licence entitlement or working call.

## 3CX

Official sources: [Programmable Extensions](https://www.3cx.com/docs/programmable-extensions/), [AI provider configuration](https://www.3cx.com/docs/agentic-call-control-ai-providers/) and [official source](https://github.com/3cx/agentic-call-control/tree/253f3d3c674042c998edf050e4e1b84eae55f1ea).

The retrieved guide specifies V20 Update 10 with Call Control access, Node 20+ and the repository's bundled Yarn. It describes Service Principal provisioning under Admin → Integrations → API, internal dialling of the Client ID and an optional DID. Actual licence access, extension scope and routing must still be proven on ChinookIT's PBX.

The source snapshot's package manager is Yarn 4.16.0. Its OpenAI workspace declares `@3cx/call-control-sdk ^0.1.10`; the lockfile resolves SDK 0.1.10, bridge `ws` 8.21.0, upstream `tsx` 4.22.4 and TypeScript 5.9.3. Its own `yarn.lock` retains every dependency resolution. Our admin application has a separate exact npm lockfile and targets Node 24 LTS.

Inspected paths:

- `examples/openai-realtime/src/index.ts`: constructs `CallControlClient`, connects it, discovers MCP tools and invokes `createCallStore`.
- `src/callcontrol/call-store.ts`: participant lifecycle, provider construction, greeting rendering and cleanup.
- `src/providers/openai-realtime.ts`: one WebSocket, PCM16 resampling between 8 kHz and 24 kHz, interruption handling, transcription and tool execution.
- `src/agent/local-tools.ts` and `tool-executor.ts`: local tool schemas, extension allowlists and routing.

The upstream loader reads plaintext `config.yaml`; upstream console output includes caller transcripts. Therefore the checked-in reference is **not launched** by our application. Phase 2 must replace configuration loading with backend-only secret access and install redacted durable event hooks before handling real calls. It must also bind call tools to immutable session/customer context and allow only the approved support destination.

## OpenAI Realtime

Official source: [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations). The current guide describes Realtime speech-to-speech conversations and WebSocket session configuration. The pinned upstream bridge uses nested realtime session audio settings and supports final input transcription plus assistant output audio transcript events.

Inspected event names include `conversation.item.input_audio_transcription.completed`, `conversation.item.input_audio_transcription.failed`, `response.output_audio_transcript.done`, `input_audio_buffer.speech_started` and `response.function_call_arguments.done`. Upstream also handles older transcript aliases. In Phase 2, deduplicate final turns by provider item/event identity and preserve incomplete/cancelled turns rather than claiming a complete transcript.

No account model access, quota, voice or audio connection has been tested. No literal model ID is selected by default in our settings. Non-demo connection testing lists account-visible Realtime model IDs using `GET /v1/models`; that is a read-access check, not an audio test. The large server-event reference page could not be fetched in full by the web tool; event wiring above is source-inspected and requires fixture and live-call validation.

## Syncro

Official sources: [API documentation](https://api-docs.syncromsp.com/) and its [OpenAPI JSON](https://api-docs.syncromsp.com/swagger.json). The downloaded snapshot is stored in `docs/contracts/syncro.openapi.json` with SHA-256 in `docs/contracts/source-manifest.json`.

The OpenAPI snapshot describes Bearer authentication and a 180 requests/minute per-IP limit. Use a dedicated least-privilege test account; confirm tenant-specific options with read access before writes.

Verified schema details:

| Operation | Route | Important fields / permission |
| --- | --- | --- |
| Customer lookup | `GET /customers` | `query`, `business_name`, `page`; Customers - List/Search |
| Customer contacts | `GET /contacts` | `customer_id`, `page`; Customers - View Detail |
| Ticket lookup | `GET /tickets` | `customer_id`, `contact_id`, `status`, `query`, `created_after`, `page`; Tickets - List/Search |
| Ticket creation | `POST /tickets` | `customer_id`, `contact_id`, `subject`, `status`, `priority`, `comments_attributes`; Tickets - Create |
| Read comments | `GET /tickets/{id}/comments` | paginated reads |
| Add comment | `POST /tickets/{id}/comment` | `subject`, `body`, `hidden`, `do_not_email`; Tickets - Edit |

The documented ticket-create body has no top-level `description` field: the intake description should map to an initial `comments_attributes[].body`, subject to a tenant staging test. Priority/status/issue-type values are strings without verified tenant enums. Phone-based customer matching must use supported search and normalization, not an invented `phone` filter. No tenant or credentials were supplied, so customer visibility, test ticket creation, comment append and timeout reconciliation remain unverified.

## Outstanding checks

- Exact installed PBX build, licence tier/Call Control entitlement, PBX HTTPS origin and network reachability.
- Service Principal credentials/scope; approved support queue/extension and PBX fallback route.
- Syncro tenant hostname, dedicated account permissions, test clinic/contact and tenant field mappings.
- OpenAI account quota and selected model/voice/transcription configuration.
- Ubuntu VM, TLS/VPN access, encrypted storage and company-approved processing/retention policy.

Secrets belong in the secured Connections UI on a dedicated test installation, never in Git, chat, screenshots or verification documents.
