# Voice worker integration boundary

Phase 2 will adapt `vendor/agentic-call-control/examples/openai-realtime`. No PBX voice worker is started by this foundation. Browser WebRTC demos run through the web server independently. Preserve the upstream audio bridge and replace configuration/logging boundaries before enabling calls. See `docs/upstream-changes.md` and `docs/integration-verification.md`.
