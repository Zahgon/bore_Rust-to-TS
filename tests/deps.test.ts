/**
 * Tests for the ported dependency layer in `src/deps/`.
 *
 * In Rust these are third-party crates with their own test suites and are
 * excluded from the project's coverage. Here they are hand-written ports, which
 * makes them the highest-risk code in the repository, so they are tested
 * directly against the semantics the application relies on.
 */

import { describe, expect, test, vi } from "vitest";

import {
  AnyhowError,
  bail,
  chain,
  context,
  debugAssert,
  debugError,
  displayError,
  ensure,
  withContext,
} from "../src/deps/anyhow.js";
import { Rng, u16 } from "../src/deps/fastrand.js";
import { Mutex } from "../src/deps/sync.js";
import * as uuid from "../src/deps/uuid.js";
import {
  copyBidirectional,
  duplex,
  formatSocketAddr,
  ioErrorKind,
  sleep,
  TcpListener,
  tcpConnect,
  timeout,
} from "../src/deps/tokio.js";
import { Authenticator } from "../src/auth.js";

describe("anyhow", () => {
  // `Display` is what lands in `ServerMessage::Error` and therefore on the wire,
  // so it must be the outermost context only — never the whole chain.
  test("Display shows only the outermost context", () => {
    const inner = new Error("inner cause");
    const outer = context(inner, "outer context");
    expect(displayError(outer)).toBe("outer context");
    expect(outer).toBeInstanceOf(AnyhowError);
  });

  test("chain walks every source", () => {
    const wrapped = context(context(new Error("root"), "middle"), "top");
    expect(chain(wrapped)).toEqual(["top", "middle", "root"]);
  });

  test("Debug renders the Caused by section", () => {
    expect(debugError(context(new Error("root"), "top"))).toBe(
      "top\n\nCaused by:\n    root",
    );
    expect(debugError(new Error("solo"))).toBe("solo");
  });

  test("a bare error has a chain of one", () => {
    expect(chain(new Error("only"))).toEqual(["only"]);
  });

  test("bail and ensure throw with the given message", () => {
    expect(() => bail("boom")).toThrow("boom");
    expect(() => ensure(false, "nope")).toThrow("nope");
    expect(() => ensure(true, "nope")).not.toThrow();
  });

  test("withContext wraps rejections but leaves successes alone", async () => {
    await expect(withContext(Promise.reject(new Error("io")), "ctx")).rejects.toThrow(
      "ctx",
    );
    await expect(withContext(Promise.resolve(7), "ctx")).resolves.toBe(7);
  });

  test("withContext accepts a lazy message", async () => {
    await expect(
      withContext(Promise.reject(new Error("io")), () => "lazy ctx"),
    ).rejects.toThrow("lazy ctx");
  });

  test("debugAssert fires outside production", () => {
    expect(() => debugAssert(false, "must hold")).toThrow(/must hold/);
    expect(() => debugAssert(true, "must hold")).not.toThrow();
  });
});

describe("fastrand", () => {
  test("u16 stays within the inclusive range", () => {
    for (let i = 0; i < 2000; i += 1) {
      const value = u16(1024, 1030);
      expect(value).toBeGreaterThanOrEqual(1024);
      expect(value).toBeLessThanOrEqual(1030);
    }
  });

  test("both endpoints are reachable", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i += 1) seen.add(u16(10, 12));
    expect([...seen].sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  test("a single-value range is degenerate", () => {
    expect(u16(42, 42)).toBe(42);
  });

  test("the full u16 range is supported", () => {
    for (let i = 0; i < 500; i += 1) {
      const value = u16(0, 65535);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(65535);
    }
  });

  test("an empty range panics, as the crate does", () => {
    expect(() => u16(100, 1)).toThrow(/empty range/);
  });

  test("the same seed reproduces the same sequence", () => {
    const a = new Rng(12345n);
    const b = new Rng(12345n);
    const left = Array.from({ length: 20 }, () => a.u16(0, 65535));
    const right = Array.from({ length: 20 }, () => b.u16(0, 65535));
    expect(left).toEqual(right);
    // A deterministic generator that returned a constant would pass the range
    // checks above, so require actual variation too.
    expect(new Set(left).size).toBeGreaterThan(1);
  });

  test("the distribution is not visibly biased", () => {
    const counts = new Array(8).fill(0);
    for (let i = 0; i < 80_000; i += 1) counts[u16(0, 7)] += 1;
    // Expect 10000 per bucket; allow a wide band, this only catches gross skew.
    for (const count of counts) {
      expect(count).toBeGreaterThan(8_500);
      expect(count).toBeLessThan(11_500);
    }
  });
});

describe("uuid", () => {
  test("newV4 produces a canonical version-4 UUID", () => {
    const value = uuid.newV4();
    expect(uuid.isUuid(value)).toBe(true);
    expect(value[14]).toBe("4");
    expect(value).toBe(value.toLowerCase());
  });

  // The authenticator hashes `as_bytes()`, so this must be the 16 raw bytes and
  // not the textual form — hashing the text would break Rust interoperability.
  test("asBytes returns the 16 raw bytes, not the text", () => {
    const bytes = uuid.asBytes("550e8400-e29b-41d4-a716-446655440000");
    expect(bytes.length).toBe(16);
    expect(bytes.toString("hex")).toBe("550e8400e29b41d4a716446655440000");
  });

  test("parse rejects malformed input and normalizes case", () => {
    expect(uuid.parse("550E8400-E29B-41D4-A716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(() => uuid.parse("nope")).toThrow(/UUID/);
    expect(() => uuid.parse("550e8400e29b41d4a716446655440000")).toThrow(/UUID/);
  });

  test("generated ids are distinct", () => {
    const set = new Set(Array.from({ length: 1000 }, () => uuid.newV4()));
    expect(set.size).toBe(1000);
  });
});

describe("sync.Mutex", () => {
  test("serializes overlapping critical sections", async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const task = async (name: string) => {
      const release = await mutex.lock();
      order.push(`${name}:enter`);
      await sleep(15);
      order.push(`${name}:exit`);
      release();
    };
    await Promise.all([task("a"), task("b"), task("c")]);
    expect(order).toEqual([
      "a:enter",
      "a:exit",
      "b:enter",
      "b:exit",
      "c:enter",
      "c:exit",
    ]);
  });
});

describe("tokio primitives", () => {
  test("timeout resolves when the work finishes first", async () => {
    const result = await timeout(1000, async () => "done");
    expect(result).toEqual({ ok: true, value: "done" });
  });

  test("timeout reports elapsed and aborts the inner work", async () => {
    let aborted = false;
    const result = await timeout(60, (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => {}); // never settles
    });
    expect(result).toEqual({ ok: false });
    expect(aborted).toBe(true);
  });

  test("a rejection after abort does not escape as an unhandled rejection", async () => {
    const result = await timeout(
      40,
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")));
        }),
    );
    expect(result).toEqual({ ok: false });
  });

  test("timeout propagates a genuine error", async () => {
    await expect(
      timeout(1000, async () => {
        throw new Error("real failure");
      }),
    ).rejects.toThrow("real failure");
  });

  test("sleep can be cancelled", async () => {
    const controller = new AbortController();
    const pending = sleep(5000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORT_ERR" });
  });

  test("ioErrorKind maps the codes the server switches on", () => {
    expect(ioErrorKind(Object.assign(new Error(), { code: "EADDRINUSE" }))).toBe(
      "AddrInUse",
    );
    expect(ioErrorKind(Object.assign(new Error(), { code: "EACCES" }))).toBe(
      "PermissionDenied",
    );
    expect(ioErrorKind(Object.assign(new Error(), { code: "ECONNRESET" }))).toBe(
      "Other",
    );
    expect(ioErrorKind(new Error("plain"))).toBe("Other");
  });

  test("formatSocketAddr brackets IPv6 like Rust's SocketAddr", () => {
    expect(formatSocketAddr({ ip: "127.0.0.1", port: 80 })).toBe("127.0.0.1:80");
    expect(formatSocketAddr({ ip: "::1", port: 80 })).toBe("[::1]:80");
  });

  test("duplex moves bytes in both directions", async () => {
    const [a, b] = duplex(64);
    const received: Buffer[] = [];
    b.on("data", (c: Buffer) => received.push(c));
    a.write("ping");
    await sleep(20);
    expect(Buffer.concat(received).toString()).toBe("ping");
  });

  test("copyBidirectional forwards both ways and reports byte counts", async () => {
    const [a1, a2] = duplex(1024);
    const [b1, b2] = duplex(1024);
    const copying = copyBidirectional(a2, b1);
    const fromB: Buffer[] = [];
    const fromA: Buffer[] = [];
    b2.on("data", (c: Buffer) => fromB.push(c));
    a1.on("data", (c: Buffer) => fromA.push(c));
    a1.write("hello");
    b2.write("world!");
    await sleep(50);
    expect(Buffer.concat(fromB).toString()).toBe("hello");
    expect(Buffer.concat(fromA).toString()).toBe("world!");
    a1.end();
    b2.end();
    await expect(copying).resolves.toEqual([5, 6]);
  });

  // Half-close is the property `half_closed_tcp_stream` depends on: EOF in one
  // direction must not tear down the other.
  test("copyBidirectional propagates EOF as a write-side shutdown only", async () => {
    const [a1, a2] = duplex(1024);
    const [b1, b2] = duplex(1024);
    void copyBidirectional(a2, b1);
    let bEnded = false;
    b2.on("end", () => {
      bEnded = true;
    });
    b2.resume();
    a1.end();
    await sleep(50);
    expect(bEnded).toBe(true);
    // The reverse direction is still usable.
    const back: Buffer[] = [];
    a1.on("data", (c: Buffer) => back.push(c));
    b2.write("still alive");
    await sleep(50);
    expect(Buffer.concat(back).toString()).toBe("still alive");
  });

  test("TcpListener binds, reports its address, and accepts", async () => {
    const listener = await TcpListener.bind("127.0.0.1", 0);
    const addr = listener.localAddr();
    expect(addr.ip).toBe("127.0.0.1");
    expect(addr.port).toBeGreaterThan(0);
    const [accepted] = await Promise.all([
      listener.accept(),
      tcpConnect("127.0.0.1", addr.port),
    ]);
    const [socket, peer] = accepted;
    expect(socket.remotePort).toBeGreaterThan(0);
    expect(peer.ip).toBe("127.0.0.1");
    expect(peer.port).toBe(socket.remotePort);
    socket.destroy();
    listener.close();
  });

  test("binding an occupied port fails with AddrInUse", async () => {
    const first = await TcpListener.bind("127.0.0.1", 0);
    const port = first.localAddr().port;
    await expect(TcpListener.bind("127.0.0.1", port)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    first.close();
  });

  // A timed-out accept must not swallow a connection that arrives later.
  test("a cancelled accept leaves the connection for the next accept", async () => {
    const listener = await TcpListener.bind("127.0.0.1", 0);
    const port = listener.localAddr().port;
    expect(await timeout(50, (signal) => listener.accept(signal))).toEqual({
      ok: false,
    });
    const client = await tcpConnect("127.0.0.1", port);
    // Wait for the listener to actually register the connection so it lands in
    // the backlog queue instead of being handed straight to a pending accept.
    // Without this the queue path is never exercised at all.
    await sleep(80);
    const [accepted, peer] = await listener.accept();
    expect(accepted.remotePort).toBe(client.localPort);
    expect(peer.port).toBe(client.localPort);
    accepted.destroy();
    client.destroy();
    listener.close();
  });
});

describe("Authenticator", () => {
  // Known-answer vectors emitted by the **Rust** `Authenticator::answer`, via a
  // throwaway test compiled against the original crate. Every other auth test
  // here compares this implementation with itself, so a self-consistent change
  // to the key derivation (for example using the raw secret instead of
  // SHA256(secret)) would pass them all while silently breaking Rust
  // interoperability. Mutation testing found exactly that hole.
  test.each([
    [
      "secret",
      "550e8400-e29b-41d4-a716-446655440000",
      "f62d14f7accaba84a37c24305f302dd835711f15c9f494048a12d9590fa1629b",
    ],
    [
      "",
      "00000000-0000-4000-8000-000000000000",
      "8d8898db347af85ea06dc6ffc729182eb7d1f272698e3659f1cc300d02f0a4fc",
    ],
    [
      "hunter2",
      "123e4567-e89b-42d3-a456-426614174000",
      "cf77d59f4bcc274ef8c1893bfa0852c8aa3e97fa8a39aaa076bfe19b8ff39400",
    ],
    [
      "a longer secret with spaces",
      "ffffffff-ffff-4fff-bfff-ffffffffffff",
      "898dbd974e2b85210e24278e5825fd4ffbaa9c92df45034439372a1172ddb90c",
    ],
  ])(
    "matches the Rust known-answer vector (secret=%s)",
    (secret, challenge, expected) => {
      const auth = new Authenticator(secret);
      expect(auth.answer(challenge)).toBe(expected);
      expect(auth.validate(challenge, expected)).toBe(true);
    },
  );

  test("answer is a 64-character hex HMAC-SHA256 tag", () => {
    const auth = new Authenticator("secret");
    const tag = auth.answer(uuid.newV4());
    expect(tag).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the same challenge and secret always produce the same tag", () => {
    const challenge = uuid.newV4();
    expect(new Authenticator("s").answer(challenge)).toBe(
      new Authenticator("s").answer(challenge),
    );
  });

  test("different secrets and different challenges diverge", () => {
    const challenge = uuid.newV4();
    expect(new Authenticator("a").answer(challenge)).not.toBe(
      new Authenticator("b").answer(challenge),
    );
    const auth = new Authenticator("a");
    expect(auth.answer(uuid.newV4())).not.toBe(auth.answer(uuid.newV4()));
  });

  test("validate rejects tags for a different challenge", () => {
    const auth = new Authenticator("s");
    const other = uuid.newV4();
    expect(auth.validate(uuid.newV4(), auth.answer(other))).toBe(false);
  });

  test("validate rejects malformed hex rather than throwing", () => {
    const auth = new Authenticator("s");
    const challenge = uuid.newV4();
    for (const tag of ["", "zz", "abc", "wrong answer", "AB".repeat(31)]) {
      expect(auth.validate(challenge, tag)).toBe(false);
    }
  });

  test("validate rejects a correct-looking tag of the wrong length", () => {
    const auth = new Authenticator("s");
    const challenge = uuid.newV4();
    const tag = auth.answer(challenge);
    expect(auth.validate(challenge, tag.slice(0, 62))).toBe(false);
    expect(auth.validate(challenge, `${tag}ab`)).toBe(false);
  });

  test("an empty secret is a valid secret", () => {
    const auth = new Authenticator("");
    const challenge = uuid.newV4();
    expect(auth.validate(challenge, auth.answer(challenge))).toBe(true);
    expect(new Authenticator("x").validate(challenge, auth.answer(challenge))).toBe(
      false,
    );
  });
});

describe("tracing", () => {
  test("respects RUST_LOG and defaults to info", async () => {
    const tracing = await import("../src/deps/tracing.js");
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    try {
      const previous = process.env["RUST_LOG"];

      delete process.env["RUST_LOG"];
      tracing.init();
      tracing.info("bore_cli::server", "visible at default");
      tracing.debug("bore_cli::server", "hidden at default");
      expect(written.join("")).toContain("visible at default");
      expect(written.join("")).not.toContain("hidden at default");

      written.length = 0;
      process.env["RUST_LOG"] = "trace";
      tracing.init();
      tracing.trace("bore_cli::shared", "now visible");
      expect(written.join("")).toContain("now visible");

      written.length = 0;
      process.env["RUST_LOG"] = "error";
      tracing.init();
      tracing.warn("bore_cli::server", "suppressed");
      tracing.error("bore_cli::server", "shown");
      expect(written.join("")).not.toContain("suppressed");
      expect(written.join("")).toContain("shown");

      if (previous === undefined) delete process.env["RUST_LOG"];
      else process.env["RUST_LOG"] = previous;
    } finally {
      spy.mockRestore();
    }
  });

  test("renders spans, fields, and the tracing line shape", async () => {
    const tracing = await import("../src/deps/tracing.js");
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    try {
      process.env["RUST_LOG"] = "info";
      tracing.init();
      await tracing.instrument(
        tracing.infoSpan("control", { addr: "127.0.0.1:1234" }),
        async () => {
          tracing.info("bore_cli::server", "incoming connection");
        },
      );
      // Strip ANSI to assert on structure rather than styling.
      const line = written
        .join("")
        .replace(/\x1b\[[0-9;]*m/g, "")
        .trimEnd();
      expect(line).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z {2}INFO control\{addr=127\.0\.0\.1:1234\}: bore_cli::server: incoming connection$/,
      );
    } finally {
      spy.mockRestore();
      delete process.env["RUST_LOG"];
    }
  });
});
