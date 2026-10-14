import { z } from "zod";
const customer = z.object({
  id: z.number().int().positive(),
  business_name: z.string().nullable().optional(),
  fullname: z.string().optional(),
});
let nextSyncroRequestAt = 0;
export class SyncroReadClient {
  private count = 0;
  constructor(
    private tenant: string,
    private key: string,
    private fetcher: typeof fetch = fetch,
    private allowedCustomerId?: string,
  ) {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(tenant))
      throw new Error("INVALID_TENANT");
  }
  private async get(path: string, params: Record<string, string>) {
    if (++this.count > 30) throw new Error("LOOKUP_BUDGET_EXCEEDED");
    const delay = Math.max(0, nextSyncroRequestAt - Date.now());
    nextSyncroRequestAt = Math.max(nextSyncroRequestAt, Date.now()) + 600;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const response = await this.fetcher(
      `https://${this.tenant}.syncromsp.com/api/v1${path}?${new URLSearchParams(params)}`,
      {
        headers: { Authorization: `Bearer ${this.key}` },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? "SYNCRO_RATE_LIMITED"
          : "SYNCRO_LOOKUP_FAILED",
      );
    const text = await response.text();
    if (text.length > 1_000_000) throw new Error("SYNCRO_RESPONSE_TOO_LARGE");
    return JSON.parse(text);
  }
  async check() {
    const b = await this.get("/customers", {
      page: "1",
      ...(this.allowedCustomerId ? { id: this.allowedCustomerId } : {}),
    });
    const found = z.object({ customers: z.array(customer) }).parse(b).customers;
    if (
      this.allowedCustomerId &&
      !found.some((c) => String(c.id) === this.allowedCustomerId)
    )
      throw new Error("TEST_CUSTOMER_NOT_FOUND");
  }
  async createTestTicket(
    customerId: string,
    contactId: string | undefined,
    subject: string,
    body: string,
  ) {
    if (!this.allowedCustomerId || customerId !== this.allowedCustomerId)
      throw new Error("TEST_CUSTOMER_NOT_ALLOWED");
    const delay = Math.max(0, nextSyncroRequestAt - Date.now());
    nextSyncroRequestAt = Math.max(nextSyncroRequestAt, Date.now()) + 600;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    let response: Response;
    try {
      response = await this.fetcher(
        `https://${this.tenant}.syncromsp.com/api/v1/tickets`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            customer_id: Number(customerId),
            ...(contactId ? { contact_id: Number(contactId) } : {}),
            subject: `[BROWSER TEST] ${subject}`.slice(0, 200),
            comments_attributes: [
              {
                subject: "Browser demo intake",
                body,
                hidden: true,
                do_not_email: true,
              },
            ],
          }),
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      throw new Error("TICKET_OUTCOME_UNKNOWN");
    }
    if (!response.ok)
      throw new Error(
        response.status >= 500 || response.status === 409
          ? "TICKET_OUTCOME_UNKNOWN"
          : "TICKET_CREATE_REJECTED",
      );
    try {
      const parsed = z
        .object({
          ticket: z.object({
            id: z.number().int().positive(),
            number: z.union([
              z.number().int().positive(),
              z.string().regex(/^\d+$/),
            ]),
            customer_id: z.number(),
          }),
        })
        .parse(await response.json()).ticket;
      if (String(parsed.customer_id) !== customerId)
        throw new Error("wrong customer");
      return {
        ticketId: String(parsed.id),
        ticketNumber: String(parsed.number),
      };
    } catch {
      throw new Error("TICKET_OUTCOME_UNKNOWN");
    }
  }
  async clinics(name: string) {
    const b = await this.get("/customers", {
      query: name,
      page: "1",
      ...(this.allowedCustomerId ? { id: this.allowedCustomerId } : {}),
    });
    return z
      .object({ customers: z.array(customer) })
      .parse(b)
      .customers.filter(
        (c) =>
          !this.allowedCustomerId || String(c.id) === this.allowedCustomerId,
      )
      .map((c) => ({
        id: String(c.id),
        name: c.business_name || c.fullname || "",
      }));
  }
}
