/**
 * Protocol-level tests for the framing codec and the serde-compatible message
 * encoding.
 *
 * `src/shared.rs` delegates these to the `tokio-util` and `serde_json` crates,
 * whose own test suites cover them; the port reimplements them, so they need
 * direct tests here. Every expectation below was cross-checked against the
 * running Rust server via a raw-socket prober.
 */

import { describe, expect, test } from "vitest";

import {
  AnyDelimiterCodec,
  ClientMessage,
  CONTROL_PORT,
  Delimited,
  MAX_FRAME_LENGTH,
  MaxChunkLengthExceededError,
  NETWORK_TIMEOUT,
  ServerMessage,
} from "../src/shared.js";
import { duplex } from "../src/deps/tokio.js";
import * as uuid from "../src/deps/uuid.js";

const NUL = 0;
const buf = (s: string): Buffer => Buffer.from(s, "utf8");

describe("protocol constants", () => {
  test("match the Rust definitions", () => {
    expect(CONTROL_PORT).toBe(7835);
    expect(MAX_FRAME_LENGTH).toBe(256);
    expect(NETWORK_TIMEOUT).toBe(3_000);
  });
});

describe("AnyDelimiterCodec", () => {
  test("encode appends the NUL terminator", () => {
    const codec = new AnyDelimiterCodec(MAX_FRAME_LENGTH);
    const encoded = codec.encode(buf("hi"));
    expect(encoded).toEqual(Buffer.from([104, 105, NUL]));
  });

  test("decode splits successive frames from one buffer", () => {
    const codec = new AnyDelimiterCodec(MAX_FRAME_LENGTH);
    const state = {
      buf: Buffer.concat([buf("a"), Buffer.from([NUL]), buf("bb"), Buffer.from([NUL])]),
    };
    expect(codec.decode(state)?.toString()).toBe("a");
    expect(codec.decode(state)?.toString()).toBe("bb");
    expect(codec.decode(state)).toBeNull();
  });

  test("decode returns null until a delimiter arrives", () => {
    const codec = new AnyDelimiterCodec(MAX_FRAME_LENGTH);
    const state = { buf: buf("partial") };
    expect(codec.decode(state)).toBeNull();
    state.buf = Buffer.concat([state.buf, Buffer.from([NUL])]);
    expect(codec.decode(state)?.toString()).toBe("partial");
  });

  test("an empty frame decodes to an empty chunk", () => {
    const codec = new AnyDelimiterCodec(MAX_FRAME_LENGTH);
    const state = { buf: Buffer.from([NUL]) };
    expect(codec.decode(state)?.length).toBe(0);
  });

  // The delimiter is searched for only within the first `max_length + 1` bytes,
  // so a payload of exactly `max_length` is the largest accepted one. Confirmed
  // against the Rust server: a 256-byte padded `Hello` is answered, 257 is not.
  test("accepts a payload of exactly max_length", () => {
    const codec = new AnyDelimiterCodec(MAX_FRAME_LENGTH);
    const payload = Buffer.alloc(MAX_FRAME_LENGTH, 0x78);
    const state = { buf: Buffer.concat([payload, Buffer.from([NUL])]) };
    expect(codec.decode(state)?.length).toBe(MAX_FRAME_LENGTH);
  });

  test("rejects a payload one byte over max_length", () => {
    const codec = new AnyDelimiterCodec(MAX_FRAME_LENGTH);
    const payload = Buffer.alloc(MAX_FRAME_LENGTH + 1, 0x78);
    const state = { buf: Buffer.concat([payload, Buffer.from([NUL])]) };
    expect(() => codec.decode(state)).toThrow(MaxChunkLengthExceededError);
  });

  // The limit applies to *buffered* bytes, not just to completed frames: the
  // codec must give up as soon as more than `max_length` bytes have arrived with
  // no delimiter, rather than waiting for one that may never come. Mutation
  // testing caught this — a delimited 257-byte frame fails either way, so only
  // undelimited input distinguishes `> max_length` from `> max_length + 1`.
  test("waits at exactly max_length undelimited bytes", () => {
    const codec = new AnyDelimiterCodec(MAX_FRAME_LENGTH);
    const state = { buf: Buffer.alloc(MAX_FRAME_LENGTH, 0x78) };
    expect(codec.decode(state)).toBeNull();
  });

  test("rejects at one byte past max_length with no delimiter in sight", () => {
    const codec = new AnyDelimiterCodec(MAX_FRAME_LENGTH);
    const state = { buf: Buffer.alloc(MAX_FRAME_LENGTH + 1, 0x78) };
    expect(() => codec.decode(state)).toThrow(MaxChunkLengthExceededError);
  });

  test("rejects a stream that dribbles past the limit without a delimiter", () => {
    const codec = new AnyDelimiterCodec(8);
    const state = { buf: Buffer.alloc(0) };
    let threw = false;
    for (let i = 0; i < 12 && !threw; i += 1) {
      state.buf = Buffer.concat([state.buf, Buffer.from("x")]);
      try {
        expect(codec.decode(state)).toBeNull();
      } catch (error) {
        threw = error instanceof MaxChunkLengthExceededError;
        // It must give up at the 9th byte: the first that exceeds max_length.
        expect(i).toBe(8);
      }
    }
    expect(threw).toBe(true);
  });

  test("after a rejection it discards until the next delimiter, then resyncs", () => {
    const codec = new AnyDelimiterCodec(8);
    const state = {
      buf: Buffer.concat([
        buf("0123456789overflow"),
        Buffer.from([NUL]),
        buf("ok"),
        Buffer.from([NUL]),
      ]),
    };
    expect(() => codec.decode(state)).toThrow(MaxChunkLengthExceededError);
    // The oversized chunk is dropped rather than surfacing as a short frame.
    expect(codec.decode(state)?.toString()).toBe("ok");
  });

  test("decodeEof emits trailing bytes that have no delimiter", () => {
    const codec = new AnyDelimiterCodec(MAX_FRAME_LENGTH);
    const state = { buf: buf("tail") };
    expect(codec.decode(state)).toBeNull();
    expect(codec.decodeEof(state)?.toString()).toBe("tail");
    expect(codec.decodeEof(state)).toBeNull();
  });
});

describe("serde wire format", () => {
  test("ClientMessage newtype variants are externally tagged", () => {
    expect(ClientMessage.serialize(ClientMessage.Hello(8080))).toEqual({ Hello: 8080 });
    expect(ClientMessage.serialize(ClientMessage.Authenticate("ab"))).toEqual({
      Authenticate: "ab",
    });
    const id = uuid.newV4();
    expect(ClientMessage.serialize(ClientMessage.Accept(id))).toEqual({ Accept: id });
  });

  test("ServerMessage unit variant serializes as a bare string", () => {
    expect(ServerMessage.serialize(ServerMessage.Heartbeat)).toBe("Heartbeat");
    expect(JSON.stringify(ServerMessage.serialize(ServerMessage.Heartbeat))).toBe(
      '"Heartbeat"',
    );
  });

  test("ServerMessage newtype variants are externally tagged", () => {
    expect(ServerMessage.serialize(ServerMessage.Hello(1))).toEqual({ Hello: 1 });
    expect(ServerMessage.serialize(ServerMessage.Error("boom"))).toEqual({
      Error: "boom",
    });
  });

  test("round-trips every variant", () => {
    const id = uuid.newV4();
    const clients = [
      ClientMessage.Authenticate("ff"),
      ClientMessage.Hello(1),
      ClientMessage.Accept(id),
    ];
    for (const message of clients) {
      expect(ClientMessage.deserialize(ClientMessage.serialize(message))).toEqual(
        message,
      );
    }
    const servers = [
      ServerMessage.Challenge(id),
      ServerMessage.Hello(2),
      ServerMessage.Heartbeat,
      ServerMessage.Connection(id),
      ServerMessage.Error("e"),
    ];
    for (const message of servers) {
      expect(ServerMessage.deserialize(ServerMessage.serialize(message))).toEqual(
        message,
      );
    }
  });

  // Rust types `recv` as `Result<Option<T>>`, so serde parses into an `Option`
  // and a literal `null` frame becomes `None` — which callers treat as EOF.
  test("a JSON null deserializes to None", () => {
    expect(ClientMessage.deserialize(null)).toBeNull();
    expect(ServerMessage.deserialize(null)).toBeNull();
  });

  test("rejects unknown variants", () => {
    expect(() => ClientMessage.deserialize({ Bogus: 1 })).toThrow(/unknown variant/);
    expect(() => ServerMessage.deserialize({ Bogus: 1 })).toThrow(/unknown variant/);
    expect(() => ServerMessage.deserialize("Bogus")).toThrow(/unknown variant/);
    // A unit-variant encoding is not valid for a newtype variant.
    expect(() => ClientMessage.deserialize("Hello")).toThrow(/unknown variant/);
  });

  test("rejects out-of-range and non-integer ports", () => {
    expect(() => ClientMessage.deserialize({ Hello: 65536 })).toThrow(/expected u16/);
    expect(() => ClientMessage.deserialize({ Hello: -1 })).toThrow(/expected u16/);
    expect(() => ClientMessage.deserialize({ Hello: 1.5 })).toThrow(/expected u16/);
    expect(() => ClientMessage.deserialize({ Hello: "80" })).toThrow(/expected u16/);
    expect(ClientMessage.deserialize({ Hello: 65535 })).toEqual(
      ClientMessage.Hello(65535),
    );
  });

  test("rejects malformed UUIDs", () => {
    expect(() => ClientMessage.deserialize({ Accept: "not-a-uuid" })).toThrow(/UUID/);
    expect(() => ServerMessage.deserialize({ Challenge: "" })).toThrow(/UUID/);
  });

  test("rejects non-enum shapes", () => {
    expect(() => ClientMessage.deserialize(42)).toThrow(/invalid type/);
    expect(() => ClientMessage.deserialize([])).toThrow(/invalid type/);
  });
});

describe("Delimited", () => {
  test("send and recv move a message across a stream", async () => {
    const [a, b] = duplex(64);
    const left = new Delimited(a);
    const right = new Delimited(b);
    await left.send(ClientMessage.serialize(ClientMessage.Hello(4242)));
    expect(await right.recv(ClientMessage.deserialize)).toEqual(
      ClientMessage.Hello(4242),
    );
  });

  test("frames are NUL-terminated on the wire", async () => {
    const [a, b] = duplex(64);
    const left = new Delimited(a);
    const chunks: Buffer[] = [];
    b.on("data", (c: Buffer) => chunks.push(c));
    await left.send(ServerMessage.serialize(ServerMessage.Heartbeat));
    await new Promise((r) => setTimeout(r, 20));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('"Heartbeat"\0'));
  });

  test("recv resolves to null at EOF", async () => {
    const [a, b] = duplex(64);
    const right = new Delimited(b);
    a.end();
    expect(await right.recv(ClientMessage.deserialize)).toBeNull();
  });

  test("recv surfaces an oversized frame as a framing error", async () => {
    const [a, b] = duplex(4096);
    const right = new Delimited(b);
    a.write(
      Buffer.concat([Buffer.alloc(MAX_FRAME_LENGTH + 1, 0x78), Buffer.from([NUL])]),
    );
    await expect(right.recv(ClientMessage.deserialize)).rejects.toThrow(
      "frame error, invalid byte length",
    );
  });

  test("recv surfaces unparseable JSON with the Rust context message", async () => {
    const [a, b] = duplex(64);
    const right = new Delimited(b);
    a.write(Buffer.concat([buf("{not json"), Buffer.from([NUL])]));
    await expect(right.recv(ClientMessage.deserialize)).rejects.toThrow(
      "unable to parse message",
    );
  });

  test("recvTimeout gives up after NETWORK_TIMEOUT", async () => {
    const [, b] = duplex(64);
    const right = new Delimited(b);
    const started = Date.now();
    await expect(right.recvTimeout(ClientMessage.deserialize)).rejects.toThrow(
      "timed out waiting for initial message",
    );
    // Allow generous slack; the point is that it waited rather than failing fast.
    expect(Date.now() - started).toBeGreaterThanOrEqual(NETWORK_TIMEOUT - 250);
  });

  // This handoff is what makes the handshake-to-proxy transition lossless: bytes
  // the codec already pulled off the socket must be forwarded, not dropped.
  test("intoParts hands over bytes buffered past the last frame", async () => {
    const [a, b] = duplex(4096);
    const right = new Delimited(b);
    a.write(
      Buffer.concat([buf('{"Hello":1}'), Buffer.from([NUL]), buf("trailing-bytes")]),
    );
    expect(await right.recv(ClientMessage.deserialize)).toEqual(ClientMessage.Hello(1));
    await new Promise((r) => setTimeout(r, 20));
    const parts = right.intoParts();
    expect(parts.readBuf.toString()).toBe("trailing-bytes");
    expect(parts.writeBuf.length).toBe(0);
    expect(parts.io).toBe(b);
  });

  test("intoParts cannot be called twice", async () => {
    const [, b] = duplex(64);
    const right = new Delimited(b);
    right.intoParts();
    expect(() => right.intoParts()).toThrow(/already been consumed/);
  });
});
