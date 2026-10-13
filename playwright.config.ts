import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  use: {
    baseURL: "http://localhost:3100",
    browserName: "chromium",
    channel: "chromium",
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: "node --import tsx scripts/e2e-server.ts",
    url: "http://localhost:3100/api/health/live",
    reuseExistingServer: false,
  },
  reporter: "list",
});
