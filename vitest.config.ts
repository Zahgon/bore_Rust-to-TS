import { defineConfig } from "vitest/config";

// The Rust suite is inherently serial: every test binds the fixed global
// `CONTROL_PORT` (7835), and `tests/e2e_test.rs` guards this with a global
// `SERIAL_GUARD` mutex. We reproduce both halves here: a single worker (so two
// files can never race for the port) plus the explicit `SERIAL_GUARD` mutex in
// `tests/e2e.test.ts`, mirroring the original one-for-one.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary", "json"],
      reportsDirectory: "coverage",
      all: true,
    },
  },
});
