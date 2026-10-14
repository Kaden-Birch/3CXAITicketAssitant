import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
export function validateKey(encoded: string): Buffer {
  if (!/^[a-fA-F0-9]{64}$/.test(encoded))
    throw new Error("MASTER_ENCRYPTION_KEY must be 64 hex characters");
  return Buffer.from(encoded, "hex");
}
export function encrypt(secret: string, key: Buffer, provider: string): string {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`chinookit:credential:v1:${provider}`));
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return JSON.stringify({
    version: 1,
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
}
export function decrypt(blob: string, key: Buffer, provider: string): string {
  const b = JSON.parse(blob);
  if (b.version !== 1) throw new Error("Unsupported key version");
  const c = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(b.nonce, "base64"),
  );
  c.setAAD(Buffer.from(`chinookit:credential:v1:${provider}`));
  c.setAuthTag(Buffer.from(b.tag, "base64"));
  return Buffer.concat([
    c.update(Buffer.from(b.data, "base64")),
    c.final(),
  ]).toString("utf8");
}
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function equal(a: string, b: string): boolean {
  return timingSafeEqual(
    Buffer.from(digest(a), "hex"),
    Buffer.from(digest(b), "hex"),
  );
}
export function redact(text: string, secrets: string[] = []): string {
  let safe = text;
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    safe = safe.split(secret).join("[REDACTED]");
  return safe
    .replace(/\bsk-[\w-]{8,}/g, "[REDACTED API KEY]")
    .replace(
      /\b(password|passcode|api[_ -]?key|authorization|MFA code|verification code)\s*(?:is|:|=)\s*\S+/gi,
      "$1: [REDACTED]",
    )
    .replace(
      /\b(?:patient name|patient DOB|date of birth|health number|PHN)\s*(?:is|:|=)\s*[^\n.;]+/gi,
      "[REDACTED PATIENT INFORMATION]",
    );
}

export function mapStrings(
  value: unknown,
  transform: (text: string) => string,
): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, transform));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mapStrings(v, transform)]),
    );
  return value;
}
