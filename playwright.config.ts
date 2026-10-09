import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4311",
    headless: true,
    launchOptions: process.env.PRAXIS_CHROME_PATH
      ? { executablePath: process.env.PRAXIS_CHROME_PATH }
      : {},
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4311",
    reuseExistingServer: false,
    env: { PRAXIS_PORT: "4311", PRAXIS_DATA_DIR: ".praxis/ui-tests" },
  },
  reporter: "list",
  outputDir: "/tmp/praxis-playwright-results",
});
