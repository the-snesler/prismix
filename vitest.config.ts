import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts: the React Router plugin isn't needed (or wanted) in tests.
export default defineConfig({
  resolve: {
    alias: { "~": fileURLToPath(new URL("./app", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["app/**/*.test.ts", "server/**/*.test.ts"],
  },
});
