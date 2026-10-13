import { z } from "zod";
import { conversationPolicy } from "../../conversation/src/policy.ts";
export const greeting =
  "Thanks for calling ChinookIT. I'm Ryan, the AI support assistant. I can help create a support ticket. Please avoid sharing patient information or passwords. What clinic are you calling from?";
export const defaultPrompt = conversationPolicy;
const httpsOrigin = z
  .string()
  .max(250)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname === "/"
      );
    } catch {
      return false;
    }
  }, "Use an HTTPS origin without a path or credentials");
export const connectionSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("pbx"),
      pbxBase: httpsOrigin,
      appId: z
        .string()
        .min(1)
        .max(80)
        .regex(/^[a-zA-Z0-9_-]+$/),
      targetVersion: z.literal("20 Update 10"),
      supportExtension: z
        .string()
        .regex(/^\d{2,8}$/)
        .or(z.literal("")),
      secret: z.string().min(1).max(4096).optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("openai"),
      model: z
        .string()
        .max(100)
        .regex(/^[a-zA-Z0-9._-]*$/),
      voice: z
        .string()
        .max(40)
        .regex(/^[a-zA-Z0-9_-]*$/),
      secret: z.string().min(1).max(4096).optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("syncro"),
      tenant: z
        .string()
        .min(1)
        .max(63)
        .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
      secret: z.string().min(1).max(4096).optional(),
    })
    .strict(),
]);
export function normalizeSyncroTenant(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(
    /^(?:https:\/\/)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.syncromsp\.com\/?$/,
  );
  return match ? match[1] : trimmed;
}
export const agentSchema = z
  .object({
    name: z.string().min(1).max(60),
    greeting: z.string().min(1).max(1000),
    prompt: z.string().min(1).max(8000),
    maxQuestions: z.number().int().min(2).max(20),
    requireConfirmation: z.literal(true),
    vadEagerness: z.enum(["low", "medium", "high"]).default("low"),
    interruptionEnabled: z.boolean().default(true),
    ticketCreationEnabled: z.boolean().default(true),
    retentionDays: z.number().int().min(1).max(365).default(30),
    diagnosticLogging: z.boolean().default(true),
  })
  .strict();
export const defaultAgent = {
  name: "Ryan",
  greeting,
  prompt: conversationPolicy,
  maxQuestions: 8,
  requireConfirmation: true as const,
  vadEagerness: "low" as const,
  interruptionEnabled: true,
  ticketCreationEnabled: true,
  retentionDays: 30,
  diagnosticLogging: true,
};
export const userSchema = z.object({
  email: z.email().max(200),
  password: z.string().min(14).max(128),
  role: z.enum(["admin", "support"]),
});
export type AgentSettings = z.infer<typeof agentSchema>;
export type Connection = z.infer<typeof connectionSchema>;
