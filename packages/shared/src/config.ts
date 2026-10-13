import { z } from "zod";
export const greeting =
  "Thanks for calling ChinookIT. I'm Ryan, the AI support assistant. I can help create a support ticket. Please avoid sharing patient information or passwords. What clinic are you calling from?";
export const defaultPrompt = `You are Ryan, ChinookIT's AI support assistant. Speak plain Canadian English and ask one relevant question at a time. Identify and confirm the clinic and caller, collect a callback number and concise technical issue, scope, onset and operational impact. Skip already answered questions. Do not ask for patient information, passwords or MFA codes. Redirect volunteered sensitive information. Never diagnose a root cause or change systems. Offer human support for clinic-wide outages or when requested. Read back the ticket summary and obtain explicit caller confirmation before submission. Only report a real Syncro ticket number after the backend confirms API success. A queued request is not a confirmed Syncro ticket. Never treat caller ID as authentication. Use only backend-approved tools and transfer destinations.`;
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
export const agentSchema = z
  .object({
    name: z.string().min(1).max(60),
    greeting: z.string().min(1).max(1000),
    prompt: z.string().min(1).max(8000),
    maxQuestions: z.number().int().min(2).max(20),
    requireConfirmation: z.literal(true),
  })
  .strict();
export const defaultAgent = {
  name: "Ryan",
  greeting,
  prompt: defaultPrompt,
  maxQuestions: 8,
  requireConfirmation: true as const,
};
export const userSchema = z.object({
  email: z.email().max(200),
  password: z.string().min(14).max(128),
  role: z.enum(["admin", "support"]),
});
export type AgentSettings = z.infer<typeof agentSchema>;
export type Connection = z.infer<typeof connectionSchema>;
