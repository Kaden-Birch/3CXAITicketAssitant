# Conversation continuity and accuracy implementation report

## Changes

- Ryan's greeting is a one-time, idempotent server activation. Mandatory runtime instructions supplement all existing saved prompts, including custom prompts; they require continuity, one short question per speaking turn, no repeated introduction, patient spelling/hesitation handling, explicit first/last name collection and authoritative caller corrections. Custom prompts remain editable and old calls retain their original versions.
- Model tools are explicitly allowlisted: `match_clinic`, `update_intake`, `confirm_intake`, `prepare_ticket`, `create_ticket`, and unavailable browser support fallback. The middle three tools operate only on this caller's intake data. No contact or existing-ticket reads are available. No customer ID, raw record, address, stored telephone or ticket history is returned to the model or inserted in the generated instructions.
- `match_clinic` must reference caller-supplied speech. Conservative normalization/edit-distance matching returns at most one similar name, requires a fresh confirmation, rejects near ties and unrelated results, and stops provider matching after five attempts per call. The chosen ID remains in server-only persisted state. Unmatched clinics can produce a local preview; they cannot produce real tickets without a confirmed binding.
- Persistent structured fields include first name, last name, original callback, validated E.164, workstation number, printer identifier, extension and location. Partial updates preserve all other data. Changed fields lose their confirmation. Captured phone digits and device/name values must have supporting caller transcript evidence. Corrections invalidate unsubmitted drafts; earlier/delayed yes turns cannot confirm newer data. Ambiguous/incomplete fields require clarification. Explicitly unavailable identity/callback information routes real mode to human review.
- Ticket body contact/device fields are assembled from confirmed server state, never reconstructed from AI prose. Short caller-facing summaries do not include technician details. Device punctuation is not automatically inserted or removed. Invalid seven-digit callbacks ask for the area code; full NANP numbers are normalized without digit substitution.
- Semantic VAD defaults to Medium (Standard / Balanced), with interruptions enabled. Session creation keeps automatic replies disabled until the one greeting activation; the activated session enables replies. WebRTC's provider-managed output buffer handles cancellation and truncation. Cancelled tool responses do not launch pending operations; tools already submitting a ticket are not cancelled. Continuations from old turns are suppressed while callers speak or a newer response runs.
- Provider cancellation/truncation events are logged. Interrupted assistant transcript text is withheld because the API does not provide reliable word/audio alignment for the heard portion. The FTS update trigger also removes it from search. This handles cancellation before or after final transcript arrival.
- Existing persisted idempotency keys, unique submission jobs, explicit final confirmation and no automatic timeout retry remain. Failed/unknown submissions retain their draft for review. Safe tool errors provide clarification or a human-support instruction; no raw provider error bodies are spoken or logged.
- The existing encrypted/write-only API-key UI and role controls remain. Agent settings add semantic eagerness, interruption enablement, real test-ticket enablement, retention days and diagnostic logging. Demo remains the per-call default. Disabling real ticket creation rejects live-test starts before provider requests. Ended sessions expire hourly using the selected retention (default 30 days); active and failed/unknown/submitting tickets are exempt. Raw recording remains unsupported and off.

## Files and configuration

Core files: `packages/conversation/src/{policy,fields,demo-intake}.ts`, `packages/syncro/src/{matching,read-client}.ts`, `packages/shared/src/config.ts`, `apps/server/src/{demo-calls,store}.ts`, and `apps/web/src/{main,DemoCall}.tsx`. Tests: `tests/{intake,demo-calls,persistence}.test.ts` and `tests/e2e/admin.spec.ts`. Generated configuration/OpenAPI schemas and browser-demo documentation are updated.

For this restricted workflow, Syncro customer matching uses Customers – List/Search. Optional ticket writes use Tickets – Create (and Ticket Comments – New for notes). Contact detail and existing-ticket list permissions are no longer needed by Ryan’s tools.

No model or voice is silently substituted: the saved OpenAI model/voice remain in use. New settings default to `vadEagerness=low`, `interruptionEnabled=true`, `ticketCreationEnabled=true`, `retentionDays=30`, `diagnosticLogging=true`. Real writes still require selecting the real-test mode and a numeric test customer ID. Human routing is configured through the existing PBX support extension, but browser calls cannot perform a PBX transfer.

## Database migration

Migration `003-intake-state.sql` adds `intake_state` for durable structured facts and server-only clinic selection, `assistant_items` for response/transcript association, and an FTS update trigger for interrupted transcript removal. It runs transactionally on startup. Provider credentials are not altered; existing settings gain defaults when read, without rewriting historical prompt versions. Retention deletes expired ended-session records and their dependent history/search data; failed or uncertain submissions remain available for review. A reviewer-controlled recovery/purge interface is still pending.

## Verification

Automated tests use synthetic identities, provider responses and browser media. They cover conservative matching/confidentiality, forbidden and prototype tool names, attempted directory retrieval, callback digit count and corrections, device preservation, missing surname, fresh confirmation, transcript ordering, semantic configuration, one greeting activation, cancelled tools, delayed cancellation/truncation, FTS removal, duplicate submission, timeout/malformed/rejected writes, preview/live separation, write kill switch, encrypted credentials, retention and migrations. Browser regressions verify patient settings persist and microphone cleanup still works.

Verification passed: `npm run build` (TypeScript and production UI build), `npm run lint`, all 40 backend tests, and both Playwright browser workflows. No live OpenAI call or Syncro write was initiated by the implementation agent.

## Remaining limitations and live verification

Speech instructions are behavioral constraints, not a proof that every model utterance will have exactly one question or that ASR will correctly interpret all uncertain audio. Backend validation prevents missing or unsupported structured values and unsafe writes; it cannot verify the truth of an audio transcript. Readback and explicit confirmation are still essential. The clinic API query returns a bounded first page; conservative matching can prefer asking for spelling over suggesting a valid but distant name.

The production 3CX worker does not yet exist in this application. The official pinned upstream bridge was inspected (`participant.getAudioWriter()`, writer `write/clear/cancel`, and its playback gate); it is preserved unmodified. 3CX queue clearing, dropping late audio, codec alignment, measured playback acknowledgements and `conversation.item.truncate` for a WebSocket/PBX bridge still require implementing that adapter and testing on Update 10. No undocumented playback acknowledgement or truncation timestamp is invented here. PBX technician transfer and production failover remain unavailable. Browser WebRTC truncation uses OpenAI's documented provider-managed behavior instead.

Before production:

1. Refresh the local browser and start in Demo ticket only. Test a hesitant caller, pauses while finding the PC label, and interruptions during Ryan's question. Verify the greeting occurs once and no interrupted phrase is repeated.
2. Give only a first name, then correct it after another answer. Verify Ryan requests the missing last name, preserves issue/clinic facts and reconfirms only the changed name.
3. Give seven callback digits, then the area code. Try `403-317-1360`, correct one digit, and verify the UI draft and ticket use the confirmed E.164 plus original capture. Spell ambiguous device characters; verify `W015` stays `W015` and a caller-requested hyphen change is explicit.
4. Try similar/ambiguous/unrelated clinic names and requests for contact lists, ticket history, addresses or credentials. Expect only one related clinic-name suggestion or spelling/human review, never private data.
5. Select the real-test mode only for a designated customer, confirm the final summary, and inspect the one `[BROWSER TEST]` ticket with internal comments. A failed/uncertain submission requires manual Syncro reconciliation using the internal call reference; do not repeat the call/write blindly.
6. Implement the PBX worker against the pinned official example, then test internal 3CX V20 Update 10 calls, barge-in at different playback offsets, queue clearing, late packets, audio truncation, technician transfer and provider outages. Verify completed writes remain completed when speech is interrupted.

Official references: [OpenAI VAD](https://developers.openai.com/api/docs/guides/realtime-vad), [interruption and truncation](https://developers.openai.com/api/docs/guides/realtime-conversations#interruption-and-truncation), the pinned Syncro OpenAPI schema in `docs/contracts`, and the official 3CX upstream source/manifest in `vendor/agentic-call-control` and `docs/integration-verification.md`.


## Follow-up from a real browser call

A user-run call exposed two gaps that the initial mocks did not cover: field validation used only the latest ASR text, and ticket preparation required separate confirmations for every name/device field. An unrelated short utterance could therefore reject a spelled correction while repeated field confirmations kept intake looping. The model also proposed an inserted device hyphen and narrated its internal tool steps.

The fixes retain ordered per-field evidence, accept late ASR without overwriting newer facts, and preserve the later correction even within one utterance. A literal caller-supplied device token overrides the model's punctuation formatting, without changing digits or inventing a prefix. Formatting-only phone updates preserve the original capture and confirmation. Unsupported stale updates return an internal repair directive, rather than burdening the caller with another clear-answer question.

Assistant question transcripts now establish readbacks. A fresh yes to the actual readback confirms the corresponding facts automatically; repeated confirmed-clinic lookups and confirmation calls are idempotent. Names and devices can remain awaiting confirmation until one short final summary, instead of separate spelling/checklist rounds. Submission requires a fresh yes to the most recent question that actually read the current summary and its pending facts; a readiness question is insufficient. Response-start audio-turn ordering handles delayed assistant transcript events. Interrupted readbacks are invalidated.

The speaking policy prohibits tool narration, routine spelling, requests to write a summary, readiness questions and revisiting already confirmed facts. If a response has already asked a question, tool completion does not launch a second speaking response. Existing custom prompts remain, with these rules taking precedence.

Additional regression fixtures use fictional identities/numbers/device labels and reproduce the failure pattern, including a spelled name followed by stray text, late ASR, stale name updates, device formatting, repeated confirmations, and an unread-summary readiness yes. Latest verification: 40 backend tests and both browser workflows passed, along with TypeScript/build and formatting checks. No additional OpenAI call or Syncro write was made by the implementation agent. The next user demo should verify actual model speech against this simpler flow.

No new SQL migration is needed for this follow-up. Optional evidence metadata is stored in the existing intake JSON. Historical call records are preserved.

## Name collection without confirmation

The user requested one name question with no routine name confirmation. Clear two-part answers to the full-name question are now captured directly from the caller transcript, including when the question transcript arrives late. A conflicting AI-proposed spelling is repaired using the captured name without asking the caller to repeat it. Missing or unclear name parts still require clarification. Name confirmation calls return captured facts and no question; names are excluded from the spoken confirmation fields in the final issue summary. Ticket wording identifies the name as caller-provided rather than verified identity. Clinic, callback and final ticket-approval gates are unchanged.

The full backend suite passed before adding the delayed-name-question regression; the updated 13-test intake suite, TypeScript/build and formatting passed afterward. CI runs the complete current suite. No SQL migration or credential change is required.


### Background noise follow-up

Added explicit pre-VAD input noise reduction with selectable room/headset profiles, English IT transcription guidance, and instructions to ignore background noise without revisiting previous answers. Added separate transcription, response, playback and tool-wait diagnostics to identify intermittent pauses. Medium (Standard / Balanced) is now the default and the local preview setting, following the caller’s request to undo Patient mode. Low remains available for extra pauses. Filtering does not guarantee correct transcription or remove other speakers. Verified with 44 backend tests and two mocked browser tests; live acoustic evaluation is outstanding.


### Repeated callback and progress filler follow-up

A confirmed callback stays locked through unrelated answers, formatting changes, empty model updates and late interruption events. Only a caller-supported correction changes the number and requires a new readback. Missing-field responses include current captured facts and name exactly one field; malformed tool arguments request silent internal repair instead of more intake questions. Clear device locations are accepted without separate confirmation, and room-number words/digits compare equivalently without changing asset identifiers. Final summary plus a submission question can authorize one submission; completion instructions end intake. Mandatory speech guidance removes repeated “one more detail” and progress narration.

Regression checks use fictional caller details and cover callback preservation, explicit corrections, room-number normalization and a single final submission yes. These enforce backend state; natural speech behavior still needs live testing.


### Caller name spelling follow-up

A captured name and an unsupported model spelling previously produced a retry result. The model could narrate that as a nonexistent saved-record spelling mismatch despite instructions to repair it silently. Known first/last names now retain caller evidence and return normal saved status when the model proposes unsupported or empty values. Results explicitly identify the name as captured and requiring no confirmation. Caller-supported corrections still apply. A regression covers both competing first/last spellings and subsequent caller corrections using fictional names.
