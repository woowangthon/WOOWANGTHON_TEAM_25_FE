const { defineConfig } = require("@playwright/test");
const { existsSync } = require("node:fs");

const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
  || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  use: {
    browserName: "chromium",
    viewport: { width: 1000, height: 700 },
    launchOptions: { executablePath }
  }
});
