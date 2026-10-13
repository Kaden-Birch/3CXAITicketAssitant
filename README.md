# ChinookIT AI Receptionist

Ryan is the ChinookIT AI support receptionist. This repository contains a development foundation and browser voice-test flow: an authenticated admin application, encrypted connection settings and a searchable SQLite conversation store. The target PBX is **3CX V20 Update 10**.

**Production PBX calls are not enabled.** Browser demo calls can use saved OpenAI/Syncro credentials, with ticket previews by default and explicitly enabled real test-ticket creation. Synthetic records and browser calls are visibly marked. See [integration verification](docs/integration-verification.md), [build checklist](docs/build-checklist.md) and [acceptance report](docs/acceptance-report.md) for verified work and outstanding prerequisites.

## Run a local synthetic demo

Use Node.js 24 LTS. The application uses Node's currently experimental `node:sqlite` module; its warning is expected. Dependencies are pinned in `package-lock.json`.

```sh
npm ci
npm run build
DEMO_MODE=true npm start
```

Open `http://localhost:3000`. On first start, the server creates `.data/bootstrap.token` with owner-only permissions. Read it locally and enter it in the first-admin form. Create your own administrator email and password (14 characters minimum); no default account exists. Do not publish the token or enter real provider credentials in a development demo.

Demo mode seeds 75 synthetic calls with completed, transferred, abandoned, failed and no-ticket outcomes. Browser testing is enabled by default; explicit connection checks and Start demo call actions can contact the saved providers. Set BROWSER_DEMO_CALLS=false for completely offline testing. Ryan's name, greeting and system prompt are editable and versioned; caller confirmation remains mandatory.

## Included in this milestone

- Same-origin React/TypeScript admin UI: Overview, Conversations, Connections, Agent settings, Users and Maintenance.
- Argon2id password hashes, expiring HttpOnly session cookies, CSRF tokens, origin checks, login rate limits and admin/support roles.
- AES-256-GCM credential encryption with provider-bound authenticated data; browser responses expose only configured status.
- SQLite WAL migrations, redacted transcript full-text search, stable cursor pagination, per-call timelines, sanitized JSON export and export audit.
- OpenAI model-list and Syncro customer-list read checks for a non-demo test installation; PBX verification remains explicitly blocked until the voice worker is connected. Read checks never prove voice or ticket-write success.
- Unmodified official 3CX reference snapshot pinned at `253f3d3c674042c998edf050e4e1b84eae55f1ea`, with upstream Yarn lockfile preserved. No second audio bridge.
- Official Syncro OpenAPI snapshot and machine-readable configuration schema.

## Validation

```sh
npm run build
npm run lint
npm test
npx playwright install chromium
npm run test:e2e
```

Browser tests start an isolated demo server and replace only `.data/e2e`, a dedicated disposable test directory. They never touch the normal `.data/receptionist.sqlite`. The CI workflow runs on Node.js 24. See [browser demo calls](docs/browser-demo-calls.md) for microphone testing and ticket modes. Docker scaffolding is provided; container runtime verification is pending.

## Deployment and next steps

See [deployment](docs/deployment.md), [PBX setup](docs/pbx-setup.md), [operator guide](docs/operator-guide.md) and [upstream changes](docs/upstream-changes.md). Do not route real callers until the voice, ticket reliability and production hardening gates pass. Production transcript capture and retention require ChinookIT policy approval.

The uploaded Markdown and Word specifications now both name Ryan. Only that name was changed in the supplied specifications.
