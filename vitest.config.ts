import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // picocolors enables colour whenever CI is set, so a GitHub Actions run
    // would bold the names inside messages the tests match as plain text.
    // Assertions read the message, not its styling, so colour is off here and
    // every environment runs the same suite.
    env: { NO_COLOR: "1" },
  },
});
