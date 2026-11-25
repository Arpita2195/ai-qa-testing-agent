import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/tests/**",
      "**/dashboard/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    testTimeout: 60000,
    hookTimeout: 60000,
    environment: "node",
  },
});
