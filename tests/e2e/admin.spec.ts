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
