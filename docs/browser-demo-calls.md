# Browser demo calls

Administrators can use **Demo call** in the sidebar or **Test Ryan in browser** on Overview. Save both provider keys, the Syncro tenant, and a Realtime model/voice in Connections first. Connection checks are read-only. Browser calls are available without a PBX configuration.

## Ticket modes

The default is **Demo ticket only**. It performs restricted clinic-name matching, prepares a local draft, reads back the summary and records confirmation. It never POSTs a ticket to Syncro or invents a ticket number.

**Create a real test ticket in Syncro** is a per-call option. Enter the permitted Syncro customer ID before starting. Customer lookup and ticket creation are restricted to that ID. The caller must confirm a newly prepared draft during the conversation. Successful requests return the authoritative ticket number; the ticket subject starts with `[BROWSER TEST]` and the initial comment requests `hidden: true` and `do_not_email: true`. Tenant automations may still trigger; use a designated test customer.

One immutable draft is submitted at most once. Correcting an unsubmitted draft supersedes it and requires a new confirmation. Network timeouts, server errors or malformed successful responses become **unknown outcome**, with no automatic retry. Review Syncro using the internal call reference before attempting another call/write. Definitive validation/permission errors are recorded as failed. Existing-ticket append is not enabled in this browser milestone.

## Audio and shared behaviour

The browser captures microphone audio over WebRTC. The backend submits the SDP offer to OpenAI's unified `/v1/realtime/calls` endpoint using the encrypted saved key, then attaches a server control WebSocket to that call. No long-lived API key or client secret is returned to the browser. Ryan's saved prompt, greeting, semantic VAD eagerness and model/voice configuration are snapshotted for the call. Mandatory continuity/confidentiality rules supplement saved custom prompts. Medium (Standard / Balanced) semantic VAD and interruption support are the defaults. Tools run on the backend through the shared conversation and Syncro services.

Use **Mute microphone** or **End call**. Navigating away releases the media tracks and attempts server hangup. Heartbeat loss ends the server session after 30 seconds; a five-minute limit bounds tests. One active test per admin and five total tests are allowed. Syncro requests share a process-wide limiter below the documented per-IP limit.

Final available transcripts and tool/ticket events are redacted and retained in Conversations, marked **Browser demo**. Raw audio is not recorded. Final ASR events can arrive asynchronously; confirmation uses the committed audio-item ordering rather than transcript arrival order so a delayed earlier “yes” does not authorize a later draft. Cancelled assistant responses are reported in the timeline. Ended calls expire using the configured retention period (30 days by default); failed or uncertain ticket submissions remain for human review. Interrupted audio text is excluded from searchable history when the provider reports cancellation/truncation.

This tests the voice/intake path without telephony. Technician transfers are simulated and explicitly reported as unavailable; it does not prove 3CX audio, routing, transfer or failover behaviour. The production PBX worker is still pending.

## Configuration and verification

Browser calls are enabled by default for this application; set `BROWSER_DEMO_CALLS=false` to disable them. `DEMO_MODE=true` seeds synthetic history; it no longer implies all outbound actions are blocked when browser testing is enabled. Each demo requires an explicit Start action. OpenAI usage charges apply.

Use localhost or HTTPS. If the Codex in-app browser cannot grant microphone access, open the same application URL in Chrome. Speaker output may require pressing Play in the audio control.

Backend provider calls and the browser media lifecycle have been tested with mocked responses/media. No actual OpenAI voice session or Syncro ticket has been created by the implementation agent. A user-run call with saved credentials remains the live verification step.

Official references: [WebRTC unified interface](https://developers.openai.com/api/docs/guides/voice-webrtc), [server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls?voice-api=realtime), [WebRTC hangup](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/hangup), and the pinned [Syncro schema](contracts/syncro.openapi.json).

See [conversation accuracy report](conversation-accuracy-report.md) for the restricted tools, structured fields, migration and live-call checklist.

Confirmations of spoken readbacks are recognized automatically. Names/devices are checked together in the short final summary; only unclear facts or an incomplete/unconfirmed callback need extra questions. Corrections retain their own transcript evidence even if later noise or delayed ASR intervenes. Repeating a confirmed clinic lookup does not restart clinic confirmation.


### Background noise and response timing

New browser calls explicitly enable OpenAI input noise reduction before VAD and model processing. Agent settings offer laptop/room microphone (`far_field`, default), headset/close microphone (`near_field`), or Off. Browser echo cancellation and noise suppression remain enabled. These filters reduce noise; they cannot guarantee rejection of nearby speech or music. No hard amplitude gate is used because clipping quiet speech would damage names and identifiers.

English transcription now has IT vocabulary guidance without caller names, clinic directory contents or device values. Ryan is instructed to ignore unrelated background sounds and keep the current intake context. Guidance is not a guarantee that noise will never be transcribed.

Voice detection now defaults to Medium (Standard / Balanced). Low/Patient remains available for extra pauses during spelling; High/Fast can cut off pauses. Saved changes apply to new calls. See [OpenAI VAD](https://developers.openai.com/api/docs/guides/realtime-vad) and [input audio configuration](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create).

Expand **Call events and response timing** to inspect provider speech-start/end events, audio-commit-to-transcription time, detected-speech-end-to-response time, response-to-playback time, and tool duration including waits for transcription evidence. These measure server event arrival, not the exact instant the person stopped talking or sound reached the speaker. Turn detection may already have waited before emitting speech_stopped. Diagnostics respect the logging switch; no raw audio is recorded.

Validation: 44 backend tests, including microphone profile selection and timing events, plus two mocked browser tests. Real microphone performance and provider latency still require a live call in the caller's environment.
