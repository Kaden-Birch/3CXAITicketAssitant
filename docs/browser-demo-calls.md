# Browser demo calls

Administrators can use **Demo call** in the sidebar or **Test Ryan in browser** on Overview. Save both provider keys, the Syncro tenant, and a Realtime model/voice in Connections first. Connection checks are read-only. Browser calls are available without a PBX configuration.

## Ticket modes

The default is **Demo ticket only**. It performs live customer/contact/open-ticket reads, prepares a local draft, reads back the summary and records confirmation. It never POSTs a ticket to Syncro or invents a ticket number.

**Create a real test ticket in Syncro** is a per-call option. Enter the permitted Syncro customer ID before starting. Customer lookup and ticket creation are restricted to that ID. The caller must confirm a newly prepared draft during the conversation. Successful requests return the authoritative ticket number; the ticket subject starts with `[BROWSER TEST]` and the initial comment requests `hidden: true` and `do_not_email: true`. Tenant automations may still trigger; use a designated test customer.

One immutable draft is submitted at most once. Correcting an unsubmitted draft supersedes it and requires a new confirmation. Network timeouts, server errors or malformed successful responses become **unknown outcome**, with no automatic retry. Review Syncro using the internal call reference before attempting another call/write. Definitive validation/permission errors are recorded as failed. Existing-ticket append is not enabled in this browser milestone.

## Audio and shared behaviour

The browser captures microphone audio over WebRTC. The backend submits the SDP offer to OpenAI's unified `/v1/realtime/calls` endpoint using the encrypted saved key, then attaches a server control WebSocket to that call. No long-lived API key or client secret is returned to the browser. Ryan's saved prompt, greeting and model/voice configuration are snapshotted for the call. Tools run on the backend through the shared conversation and Syncro services.

Use **Mute microphone** or **End call**. Navigating away releases the media tracks and attempts server hangup. Heartbeat loss ends the server session after 30 seconds; a five-minute limit bounds tests. One active test per admin and five total tests are allowed. Syncro requests share a process-wide limiter below the documented per-IP limit.

Final available transcripts and tool/ticket events are redacted and retained in Conversations, marked **Browser demo**. Raw audio is not recorded. Final ASR events can arrive asynchronously; confirmation uses the committed audio-item ordering rather than transcript arrival order so a delayed earlier “yes” does not authorize a later draft. Cancelled assistant responses are reported in the timeline. Production transcript-retention/privacy approvals remain outstanding.

This tests the voice/intake path without telephony. Technician transfers are simulated and explicitly reported as unavailable; it does not prove 3CX audio, routing, transfer or failover behaviour. The production PBX worker is still pending.

## Configuration and verification

Browser calls are enabled by default for this application; set `BROWSER_DEMO_CALLS=false` to disable them. `DEMO_MODE=true` seeds synthetic history; it no longer implies all outbound actions are blocked when browser testing is enabled. Each demo requires an explicit Start action. OpenAI usage charges apply.

Use localhost or HTTPS. If the Codex in-app browser cannot grant microphone access, open the same application URL in Chrome. Speaker output may require pressing Play in the audio control.

Backend provider calls and the browser media lifecycle have been tested with mocked responses/media. No actual OpenAI voice session or Syncro ticket has been created by the implementation agent. A user-run call with saved credentials remains the live verification step.

Official references: [WebRTC unified interface](https://developers.openai.com/api/docs/guides/voice-webrtc), [server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls?voice-api=realtime), [WebRTC hangup](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/hangup), and the pinned [Syncro schema](contracts/syncro.openapi.json).
