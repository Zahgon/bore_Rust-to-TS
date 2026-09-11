import { expect, test } from "vitest";

import { main, run } from "../src/main.js";

/**
 * The CLI entry point. `main.rs` keeps `run` and `main` private, but Rust can
 * unit-test private items from inside the crate and TypeScript cannot, so both
 * are exported here and the auto-invocation is guarded to direct execution.
 * Importing this module must therefore *not* start the CLI.
 */

test("importing the entry point does not run the CLI", () => {
  // If the module still called `main()` at import, this file would have tried
  // to parse vitest's argv and exited the worker before reaching the assertion.
  expect(typeof main).toBe("function");
  expect(typeof run).toBe("function");
});

test("an unhandled command is rejected", async () => {
  // Rust's `match command { Command::Local{..} => .., Command::Server{..} => .. }`
  // is exhaustive over the enum; the port reaches this arm only if the parser
  // ever yields a command the runner does not know.
  await expect(run("nonexistent", {})).rejects.toThrow("unhandled command: nonexistent");
});
