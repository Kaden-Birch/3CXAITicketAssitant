import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { buildApp } from "./app.ts";
import { Store } from "./store.ts";
import { validateKey } from "../../../packages/security/src/index.ts";
const demo = process.env.DEMO_MODE === "true",
  data = resolve(process.env.DATA_DIR ?? ".data");
mkdirSync(data, { recursive: true, mode: 0o700 });
chmodSync(data, 0o700);
const keyFile = resolve(data, "demo-master.key");
let encoded = process.env.MASTER_ENCRYPTION_KEY;
if (!encoded && demo) {
  if (!existsSync(keyFile))
    writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  encoded = readFileSync(keyFile, "utf8").trim();
}
if (!encoded)
  throw new Error(
    "Provide MASTER_ENCRYPTION_KEY before startup, or explicitly enable DEMO_MODE=true for local synthetic data.",
  );
const tokenFile = resolve(data, "bootstrap.token");
if (!existsSync(tokenFile))
  writeFileSync(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
const port = Number(process.env.PORT ?? 3000),
  origin = process.env.APP_ORIGIN ?? `http://localhost:${port}`;
if (!demo && !origin.startsWith("https://"))
  throw new Error(
    "Non-demo installs require an HTTPS APP_ORIGIN and reverse proxy.",
  );
const store = new Store(resolve(data, "receptionist.sqlite"));
chmodSync(resolve(data, "receptionist.sqlite"), 0o600);
if (demo) store.seed();
const app = await buildApp({
  store,
  key: validateKey(encoded),
  bootstrapToken: readFileSync(tokenFile, "utf8").trim(),
  origin,
  demo,
  browserDemoEnabled: process.env.BROWSER_DEMO_CALLS !== "false",
  webRoot: resolve("apps/web/dist"),
});
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
console.log(
  `ChinookIT AI Receptionist: ${origin}; target 3CX V20 Update 10; PBX voice disabled; browser calls available when enabled.`,
);
if (!store.db.prepare("SELECT id FROM users LIMIT 1").get())
  console.log(
    `First-run token file: ${tokenFile}. Read locally and enter it in setup; do not share it.`,
  );
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
