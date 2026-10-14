# Deployment

This is a development foundation. It does not accept PBX calls. Browser demos can create a real test ticket only when that mode is explicitly selected. Node 24 LTS is the deployment target; `node:sqlite` is experimental and must be revalidated before runtime upgrades.

## Local demo

Run `npm ci`, `npm run build`, then `DEMO_MODE=true npm start`. Open `http://localhost:3000`. Read `.data/bootstrap.token` locally and complete first-admin setup. The server binds to loopback by default. The demo generates `.data/demo-master.key` with owner-only access; never use that demo key for a real deployment.

Changing the hostname used in the browser requires matching `APP_ORIGIN` exactly. Origin checks reject writes from a different hostname/port. Passwords and secrets are not printed by the server. Do not share setup tokens.

## Compose demo

From the repository root:

```sh
docker compose -f infra/compose.yaml up --build -d
docker compose -f infra/compose.yaml exec web cat /data/bootstrap.token
```

The second command displays the setup token only in your local terminal. Enter it in the setup form and keep it private. The named volume persists SQLite and setup state. Compose publishes only `127.0.0.1:3000`, drops capabilities and uses a non-root container. Container build/run remains unverified in this session because the Docker daemon was unavailable.

## Dedicated integration test installation

Use an approved Ubuntu VM with LAN/VPN access and a valid TLS reverse proxy. Provision a separate clean data volume. Supply `DEMO_MODE=false`, an exact HTTPS `APP_ORIGIN`, and `MASTER_ENCRYPTION_KEY` as a random 32-byte value encoded in 64 hexadecimal characters. Protect the environment/secret configuration; never check it into Git. The encryption key is provided outside the UI and must be backed up separately from the database.

`infra/Caddyfile.example` illustrates a host reverse proxy to loopback. This application does not automatically install TLS, DNS or VPN infrastructure. Review the example for your environment before use. Explicit browser demos and model/customer read checks can make external requests when BROWSER_DEMO_CALLS is enabled. PBX voice remains disabled. See browser-demo-calls.md.

## Storage and recovery

The SQLite database uses WAL and schema migrations. Use SQLite's online backup facility or stop the app and copy the database together with its WAL state consistently. Do not copy a running database file alone. Exclude `demo-master.key`, bootstrap tokens and environment files from conversation/audit exports and database backups. Protect the separately stored master key; without it credentials cannot be decrypted.

A production backup/restore procedure, key rotation and retention expiration must be implemented and tested in Phase 4. Do not represent this scaffold as a completed backup system.
