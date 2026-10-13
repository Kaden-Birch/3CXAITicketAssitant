import { rmSync } from "node:fs";
import { resolve } from "node:path";
// Dedicated disposable test database; never use the application's normal data directory.
process.env.DATA_DIR = resolve(".data/e2e");
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
process.env.DEMO_MODE = "true";
process.env.PORT = "3100";
process.env.APP_ORIGIN = "http://localhost:3100";
await import("../apps/server/src/index.ts");
