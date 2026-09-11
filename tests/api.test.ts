/**
 * Public API surface, mirroring the `pub mod` declarations in `src/lib.rs`.
 *
 * Rust's `lib.rs` contains no executable lines, so it never appears in coverage;
 * the equivalent re-export module here is checked directly instead.
 */

import { describe, expect, test } from "vitest";

import * as bore from "../src/index.js";

describe("public API", () => {
  test("exposes the four modules that lib.rs declares", () => {
    for (const name of ["auth", "client", "server", "shared"] as const) {
      expect(bore[name]).toBeTypeOf("object");
    }
  });

  test("re-exports the primary types", () => {
    expect(bore.Authenticator).toBeTypeOf("function");
    expect(bore.Client).toBeTypeOf("function");
    expect(bore.Server).toBeTypeOf("function");
    expect(bore.PortRange).toBeTypeOf("function");
    expect(bore.Delimited).toBeTypeOf("function");
  });

  test("re-exports the protocol constants with the Rust values", () => {
    expect(bore.CONTROL_PORT).toBe(7835);
    expect(bore.MAX_FRAME_LENGTH).toBe(256);
    expect(bore.NETWORK_TIMEOUT).toBe(3_000);
  });

  test("module and top-level exports are the same bindings", () => {
    expect(bore.auth.Authenticator).toBe(bore.Authenticator);
    expect(bore.server.Server).toBe(bore.Server);
    expect(bore.client.Client).toBe(bore.Client);
    expect(bore.shared.CONTROL_PORT).toBe(bore.CONTROL_PORT);
  });

  test("PortRange models RangeInclusive", () => {
    const range = new bore.PortRange(1024, 2048);
    expect(range.isEmpty()).toBe(false);
    expect(range.contains(1024)).toBe(true);
    expect(range.contains(2048)).toBe(true);
    expect(range.contains(1023)).toBe(false);
    expect(range.contains(2049)).toBe(false);
    expect(new bore.PortRange(5000, 3000).isEmpty()).toBe(true);
    expect(new bore.PortRange(42, 42).isEmpty()).toBe(false);
  });
});
