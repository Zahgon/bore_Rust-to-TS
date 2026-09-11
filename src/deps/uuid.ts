/**
 * Port of the `uuid` crate surface that `bore` uses: v4 generation, the
 * hyphenated lowercase `Display` form, and `as_bytes()`.
 *
 * A UUID is represented as its canonical string so it can travel through JSON
 * unchanged, but `asBytes` is what the authenticator hashes — the crate's
 * `as_bytes()` returns the 16 raw bytes, *not* the textual form, and hashing
 * the wrong one would silently break interoperability with the Rust server.
 */

import { randomUUID } from "node:crypto";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A UUID in its canonical hyphenated form. */
export type Uuid = string;

/** `Uuid::new_v4()`. */
export function newV4(): Uuid {
  return randomUUID();
}

/** Whether a string is a well-formed hyphenated UUID. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** `Uuid::parse_str`, rejecting malformed input the way serde does. */
export function parse(value: string): Uuid {
  if (!isUuid(value)) {
    throw new Error(`UUID parsing failed: invalid format: ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}

/** `Uuid::as_bytes()` — the 16 raw bytes behind the textual form. */
export function asBytes(value: Uuid): Buffer {
  return Buffer.from(parse(value).replace(/-/g, ""), "hex");
}
