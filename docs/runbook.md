# Development runbook

- App does not start: verify Node 24+, dependencies, build output and master key format. Non-demo requires an HTTPS APP_ORIGIN. Inspect errors without printing credentials.
- Setup rejects writes: browser origin must exactly match APP_ORIGIN. Use the locally generated bootstrap token, then a unique admin password of at least 14 characters.
- Login fails: verify account and password. Five login attempts per minute are permitted per source IP. No shared/default password exists.
- Provider test says blocked: demo mode intentionally blocks all outbound checks; PBX checks require Phase 2. Read-only OpenAI/Syncro checks require saved settings and credentials on a non-demo test installation.
- Provider returns an HTTP error: verify account permissions and quota. Raw provider errors are deliberately not retained or returned. No ticket was created by a connection test.
- Live call/ticket unavailable: expected for this milestone. Use the existing technician route while voice and ticket gates remain incomplete.
- Recovery: stop the service before an offline database copy, preserve the key separately, and follow a tested restore plan before production.
