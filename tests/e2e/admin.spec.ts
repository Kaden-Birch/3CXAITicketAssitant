import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
test("first-run setup, masked settings, search, role restrictions and mobile layout", async ({
  page,
}) => {
  const token = readFileSync(".data/e2e/bootstrap.token", "utf8").trim();
  await page.goto("/");
  await page.getByLabel("First-run setup token").fill(token);
  await page.getByLabel("Email", { exact: true }).fill("ui-admin@example.test");
  await page.getByLabel(/^Password/).fill("Synthetic UI password 123");
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Ryan", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const openai = page.locator("section").filter({
    has: page.getByRole("heading", { name: "OpenAI Realtime", exact: true }),
  });
  const secret = "sk-synthetic_browser_test_only";
  await openai.getByLabel("API key", { exact: true }).fill(secret);
  await openai.getByRole("button", { name: "Save connection" }).click();
  await expect(page.getByRole("status")).toContainText("Connection saved");
  await expect(openai.getByLabel("API key", { exact: true })).toHaveValue("");
  expect(await page.locator("body").textContent()).not.toContain(secret);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage })),
  ).not.toContain(secret);
  await openai.getByRole("button", { name: "Test saved connection" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Demo mode does not contact external providers",
  );
  const syncro = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Syncro MSP", exact: true }),
  });
  await syncro
    .getByLabel("Syncro tenant or address")
    .fill("https://wrong.example.com");
  await syncro
    .getByLabel("API key", { exact: true })
    .fill("synthetic-syncro-key");
  await syncro.getByRole("button", { name: "Save connection" }).click();
  await expect(page.getByRole("alert")).toContainText("Syncro tenant:");
  await syncro
    .getByLabel("Syncro tenant or address")
    .fill(" https://Synthetic-Clinic.syncromsp.com/ ");
  await syncro.getByRole("button", { name: "Save connection" }).click();
  await expect(page.getByRole("status")).toContainText("Connection saved");
  await expect(syncro.getByLabel("API key", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(syncro.getByLabel("Syncro tenant or address")).toHaveValue(
    "synthetic-clinic",
  );
  await page
    .getByRole("button", { name: "Agent settings", exact: true })
    .click();
  await expect(page.getByLabel("Voice detection patience")).toHaveValue(
    "medium",
  );
  await expect(page.getByLabel("Allow callers to interrupt")).toHaveValue(
    "true",
  );
  await page.getByLabel("Voice detection patience").selectOption("medium");
  await page.getByLabel("Real test ticket creation").selectOption("false");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByRole("status")).toContainText("Agent version saved");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page
    .getByRole("button", { name: "Agent settings", exact: true })
    .click();
  await expect(page.getByLabel("Voice detection patience")).toHaveValue(
    "medium",
  );
  await expect(page.getByLabel("Real test ticket creation")).toHaveValue(
    "false",
  );
  await page.getByLabel("Voice detection patience").selectOption("low");
  await page.getByLabel("Real test ticket creation").selectOption("true");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByRole("status")).toContainText("Agent version saved");
  await page
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await expect(page.locator("tbody tr")).toHaveCount(20);
  await page.getByRole("button", { name: "Load more conversations" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(40);
  await page
    .getByLabel("Search", { exact: true })
    .fill("destination unavailable");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(20);
  await page.getByRole("button", { name: "View", exact: true }).first().click();
  await expect(
    page.getByText("Transcript status:", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".turn")).toHaveCount(5);
  expect(await page.locator("body").textContent()).not.toContain(
    "synthetic-secret",
  );
  await page.screenshot({
    path: "test-results/ui-conversation.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Technical events", exact: true })
    .click();
  await expect(page.locator(".timeline li")).toHaveCount(4);
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await page
    .getByLabel("Email", { exact: true })
    .fill("ui-support@example.test");
  await page
    .getByLabel("Initial password")
    .fill("Synthetic support password 123");
  await page.getByRole("button", { name: "Create user", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("User created");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Email", { exact: true })
    .fill("ui-support@example.test");
  await page.getByLabel(/^Password/).fill("Synthetic support password 123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connections", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await page.getByRole("button", { name: "View", exact: true }).first().click();
  await expect(
    page.getByRole("link", { name: "Download sanitized JSON" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/ui-mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("browser demo uses preview by default, gates real writes and stops the microphone", async ({
  page,
}) => {
  const id = "12345678-1234-4234-8234-123456789abc";
  const starts: any[] = [];
  let ends = 0;
  let expired = false;
  await page.addInitScript(() => {
    (window as any).stoppedTracks = 0;
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: async () => ({
          getTracks: () => [
            {
              stop: () => {
                (window as any).stoppedTracks++;
              },
              enabled: true,
            },
          ],
          getAudioTracks: () => [],
        }),
      },
    });
    (window as any).RTCPeerConnection = class {
      channel: any;
      onconnectionstatechange: any;
      connectionState = "connected";
      addTrack() {}
      createDataChannel() {
        this.channel = {};
        return this.channel;
      }
      async createOffer() {
        return { sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" };
      }
      async setLocalDescription() {}
      async setRemoteDescription() {
        setTimeout(() => this.channel.onopen?.(), 0);
      }
      close() {
        this.connectionState = "closed";
      }
    };
  });
  await page.route("**/api/demo-calls**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/status"))
      return route.fulfill({
        json: {
          enabled: true,
          ready: true,
          agentName: "Ryan",
          model: "test-realtime",
          voice: "alloy",
        },
      });
    if (url.endsWith("/api/demo-calls")) {
      starts.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          id,
          sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
          writeMode: starts.at(-1).writeMode,
        },
      });
    }
    if (url.endsWith("/activate")) return route.fulfill({ json: { ok: true } });
    if (url.endsWith("/end")) {
      ends++;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({
      json: {
        id,
        status: ends || expired ? "ended" : "active",
        remainingSeconds: ends || expired ? 0 : 59,
        endReason: expired ? "duration_limit" : ends ? "ended" : "",
        session: { outcome: "no_ticket" },
        turns: [],
        events: [],
        draft: null,
      },
    });
  });
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("ui-admin@example.test");
  await page.getByLabel(/^Password/).fill("Synthetic UI password 123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Demo call", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: /Demo ticket only/ }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "Start demo call", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Mute microphone", exact: true }),
  ).toBeEnabled();
  expect(starts[0].writeMode).toBe("preview");
  await expect(page.getByText(/Demo time remaining: 0:59/)).toBeVisible();
  expired = true;
  await expect(page.getByText(/reached its five-minute limit/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start demo call", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => (window as any).stoppedTracks)).toBe(1);
  expired = false;
  await page
    .getByRole("radio", {
      name: "Create a real test ticket in Syncro",
      exact: true,
    })
    .check();
  await expect(
    page.getByRole("button", { name: "Start demo call", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Syncro test customer ID").fill("42");
  await page
    .getByRole("button", { name: "Start demo call", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Mute microphone", exact: true }),
  ).toBeEnabled();
  expect(starts[1]).toMatchObject({
    writeMode: "live_test",
    testCustomerId: "42",
  });
  await page.getByRole("button", { name: "End call", exact: true }).click();
  await page.screenshot({
    path: "test-results/browser-demo-call.png",
    fullPage: true,
  });
});
