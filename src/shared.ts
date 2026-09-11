/** Shared data structures, utilities, and protocol definitions. */

import type { Duplex } from "node:stream";

import { context, debugAssert, withContext } from "./deps/anyhow.js";
import { timeout } from "./deps/tokio.js";
import * as uuid from "./deps/uuid.js";
import * as tracing from "./deps/tracing.js";

const TARGET = "bore_cli::shared";

/** TCP port used for control connections with the server. */
export const CONTROL_PORT = 7835;

/** Maximum byte length for a JSON frame in the stream. */
export const MAX_FRAME_LENGTH = 256;

/** Timeout for network connections and initial protocol messages, in milliseconds. */
export const NETWORK_TIMEOUT = 3_000;

/** A message from the client on the control connection. */
export type ClientMessage =
  /** Response to an authentication challenge from the server. */
  | { readonly kind: "Authenticate"; readonly value: string }
  /** Initial client message specifying a port to forward. */
  | { readonly kind: "Hello"; readonly value: number }
  /** Accepts an incoming TCP connection, using this stream as a proxy. */
  | { readonly kind: "Accept"; readonly value: string };

/** A message from the server on the control connection. */
export type ServerMessage =
  /** Authentication challenge, sent as the first message, if enabled. */
  | { readonly kind: "Challenge"; readonly value: string }
  /** Response to a client's initial message, with actual public port. */
  | { readonly kind: "Hello"; readonly value: number }
  /** No-op used to test if the client is still reachable. */
  | { readonly kind: "Heartbeat" }
  /** Asks the client to accept a forwarded TCP connection. */
  | { readonly kind: "Connection"; readonly value: string }
  /** Indicates a server error that terminates the connection. */
  | { readonly kind: "Error"; readonly value: string };

const U16_MAX = 65_535;

function invalidType(value: unknown, expected: string): Error {
  const rendered =
    typeof value === "string"
      ? `string ${JSON.stringify(value)}`
      : value === null
        ? "null"
        : Array.isArray(value)
          ? "sequence"
          : typeof value === "object"
            ? "map"
            : typeof value === "boolean"
              ? `boolean \`${value}\``
              : `integer \`${String(value)}\``;
  return new Error(`invalid type: ${rendered}, expected ${expected}`);
}

function unknownVariant(name: string, expected: readonly string[]): Error {
  const list = expected.map((variant) => `\`${variant}\``).join(", ");
  return new Error(`unknown variant \`${name}\`, expected one of ${list}`);
}

function expectString(value: unknown, expected: string): string {
  if (typeof value !== "string") throw invalidType(value, expected);
  return value;
}

/** serde's `Uuid` deserializer: a string that must parse as a UUID. */
function expectUuid(value: unknown): string {
  return uuid.parse(expectString(value, "a UUID string"));
}

function expectU16(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidType(value, "u16");
  }
  if (value < 0 || value > U16_MAX) {
    throw new Error(`invalid value: integer \`${value}\`, expected u16`);
  }
  return value;
}

/**
 * Split an externally tagged serde enum value into its variant and payload.
 *
 * serde's default enum representation is a bare string for a unit variant and a
 * single-key map for a newtype variant, which is the format on the wire.
 */
function splitVariant(
  value: unknown,
  expected: readonly string[],
): { variant: string; payload: unknown; unit: boolean } {
  if (typeof value === "string") {
    return { variant: value, payload: undefined, unit: true };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidType(value, "enum");
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1) {
    throw new Error(
      "expected value at line 1 column 1: map with a single key, found " +
        `${keys.length} keys`,
    );
  }
  const variant = keys[0] as string;
  if (!expected.includes(variant)) {
    throw unknownVariant(variant, expected);
  }
  return { variant, payload: (value as Record<string, unknown>)[variant], unit: false };
}

const CLIENT_VARIANTS = ["Authenticate", "Hello", "Accept"] as const;
const SERVER_VARIANTS = [
  "Challenge",
  "Hello",
  "Heartbeat",
  "Connection",
  "Error",
] as const;

/** Constructors and codec for {@link ClientMessage}. */
export const ClientMessage = {
  Authenticate: (value: string): ClientMessage => ({ kind: "Authenticate", value }),
  Hello: (value: number): ClientMessage => ({ kind: "Hello", value }),
  Accept: (value: string): ClientMessage => ({ kind: "Accept", value }),

  /** serde's `Serialize` — externally tagged, matching the Rust wire format. */
  serialize(message: ClientMessage): unknown {
    return { [message.kind]: message.value };
  },

  /**
   * serde's `Deserialize` for `Option<ClientMessage>`.
   *
   * A JSON `null` deserializes to `None`, exactly as in Rust, where `recv`'s
   * return type makes `serde_json` parse into an `Option`.
   */
  deserialize(value: unknown): ClientMessage | null {
    if (value === null) return null;
    const { variant, payload, unit } = splitVariant(value, CLIENT_VARIANTS);
    if (unit) throw unknownVariant(variant, CLIENT_VARIANTS);
    switch (variant) {
      case "Authenticate":
        return ClientMessage.Authenticate(expectString(payload, "a string"));
      case "Hello":
        return ClientMessage.Hello(expectU16(payload));
      case "Accept":
        return ClientMessage.Accept(expectUuid(payload));
      default:
        throw unknownVariant(variant, CLIENT_VARIANTS);
    }
  },
} as const;

/** Constructors and codec for {@link ServerMessage}. */
export const ServerMessage = {
  Challenge: (value: string): ServerMessage => ({ kind: "Challenge", value }),
  Hello: (value: number): ServerMessage => ({ kind: "Hello", value }),
  Heartbeat: { kind: "Heartbeat" } as ServerMessage,
  Connection: (value: string): ServerMessage => ({ kind: "Connection", value }),
  Error: (value: string): ServerMessage => ({ kind: "Error", value }),

  /** serde's `Serialize`; the unit variant `Heartbeat` becomes a bare string. */
  serialize(message: ServerMessage): unknown {
    if (message.kind === "Heartbeat") return "Heartbeat";
    return { [message.kind]: message.value };
  },

  /** serde's `Deserialize` for `Option<ServerMessage>`. */
  deserialize(value: unknown): ServerMessage | null {
    if (value === null) return null;
    const { variant, payload, unit } = splitVariant(value, SERVER_VARIANTS);
    if (unit) {
      if (variant !== "Heartbeat") throw unknownVariant(variant, SERVER_VARIANTS);
      return ServerMessage.Heartbeat;
    }
    switch (variant) {
      case "Challenge":
        return ServerMessage.Challenge(expectUuid(payload));
      case "Hello":
        return ServerMessage.Hello(expectU16(payload));
      case "Connection":
        return ServerMessage.Connection(expectUuid(payload));
      case "Error":
        return ServerMessage.Error(expectString(payload, "a string"));
      case "Heartbeat":
        throw invalidType(payload, "unit variant");
      default:
        throw unknownVariant(variant, SERVER_VARIANTS);
    }
  },
} as const;

/** The error `AnyDelimiterCodec` raises when a chunk exceeds `max_length`. */
export class MaxChunkLengthExceededError extends Error {
  constructor() {
    super("max chunk length exceeded");
  }
}

/**
 * Port of `tokio_util::codec::AnyDelimiterCodec`, configured exactly as `bore`
 * configures it: seek on NUL, write NUL, and a `max_length` of
 * {@link MAX_FRAME_LENGTH}.
 *
 * The length check is deliberately faithful: the delimiter is searched for only
 * within the first `max_length + 1` bytes, so a payload of exactly `max_length`
 * bytes is accepted while one byte more is rejected. After a rejection the
 * codec enters a discarding state until the next delimiter resynchronises it.
 */
export class AnyDelimiterCodec {
  private nextIndex = 0;
  private isDiscarding = false;

  constructor(private readonly maxLength: number) {}

  /** `Decoder::decode`; returns the frame, or `null` if more data is needed. */
  decode(state: { buf: Buffer }): Buffer | null {
    for (;;) {
      const readTo = Math.min(this.maxLength + 1, state.buf.length);

      let offset = -1;
      for (let i = this.nextIndex; i < readTo; i += 1) {
        if (state.buf[i] === 0) {
          offset = i - this.nextIndex;
          break;
        }
      }

      if (this.isDiscarding && offset >= 0) {
        state.buf = state.buf.subarray(offset + this.nextIndex + 1);
        this.isDiscarding = false;
        this.nextIndex = 0;
        continue;
      }
      if (this.isDiscarding) {
        state.buf = state.buf.subarray(readTo);
        this.nextIndex = 0;
        if (state.buf.length === 0) return null;
        continue;
      }
      if (offset >= 0) {
        const chunkIndex = offset + this.nextIndex;
        this.nextIndex = 0;
        const chunk = state.buf.subarray(0, chunkIndex);
        state.buf = state.buf.subarray(chunkIndex + 1);
        return chunk;
      }
      if (state.buf.length > this.maxLength) {
        this.isDiscarding = true;
        throw new MaxChunkLengthExceededError();
      }
      this.nextIndex = readTo;
      return null;
    }
  }

  /** `Decoder::decode_eof`; trailing bytes become a final frame. */
  decodeEof(state: { buf: Buffer }): Buffer | null {
    const frame = this.decode(state);
    if (frame !== null) return frame;
    if (state.buf.length === 0) return null;
    const chunk = state.buf;
    state.buf = Buffer.alloc(0);
    this.nextIndex = 0;
    return chunk;
  }

  /** `Encoder::encode`; appends the NUL terminator. */
  encode(chunk: Buffer): Buffer {
    return Buffer.concat([chunk, Buffer.from([0])]);
  }
}

/** The pieces of a {@link Delimited}, mirroring `tokio_util::codec::FramedParts`. */
export interface FramedParts<U extends Duplex> {
  io: U;
  readBuf: Buffer;
  writeBuf: Buffer;
}

interface Waiter {
  resolve: (frame: Buffer | null) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

/** Transport stream with JSON frames delimited by null characters. */
export class Delimited<U extends Duplex> {
  private readonly codec = new AnyDelimiterCodec(MAX_FRAME_LENGTH);
  private readonly state: { buf: Buffer } = { buf: Buffer.alloc(0) };
  private readonly frames: Array<Buffer | null> = [];
  private readonly waiters: Waiter[] = [];
  private failure: Error | null = null;
  private finished = false;
  private detached = false;

  private readonly onData = (chunk: Buffer): void => {
    this.state.buf = Buffer.concat([this.state.buf, chunk]);
    this.drain(false);
  };
  private readonly onEnd = (): void => {
    this.finished = true;
    this.drain(true);
  };
  private readonly onError = (error: Error): void => {
    this.fail(error);
  };

  /** Construct a new delimited stream. */
  constructor(private readonly stream: U) {
    stream.on("data", this.onData);
    stream.on("end", this.onEnd);
    stream.on("error", this.onError);
  }

  /** The underlying transport, for callers that need its address or lifetime. */
  get io(): U {
    return this.stream;
  }

  private drain(atEof: boolean): void {
    try {
      for (;;) {
        const frame = atEof
          ? this.codec.decodeEof(this.state)
          : this.codec.decode(this.state);
        if (frame === null) break;
        this.push(frame);
      }
      if (atEof) this.push(null);
    } catch (error) {
      this.fail(error as Error);
    }
  }

  private push(frame: Buffer | null): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(frame);
    } else {
      this.frames.push(frame);
    }
  }

  private fail(error: Error): void {
    this.failure = error;
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const waiter of waiters) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
  }

  private nextFrame(signal?: AbortSignal): Promise<Buffer | null> {
    if (this.frames.length > 0) {
      return Promise.resolve(this.frames.shift() as Buffer | null);
    }
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.finished) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("operation was cancelled"));
        return;
      }
      const waiter: Waiter = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("operation was cancelled"));
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  /**
   * Read the next null-delimited JSON instruction from a stream.
   *
   * The `deserialize` argument stands in for Rust's `T: DeserializeOwned` type
   * parameter, which TypeScript cannot recover at runtime.
   */
  async recv<T>(
    deserialize: (value: unknown) => T | null,
    signal?: AbortSignal,
  ): Promise<T | null> {
    tracing.trace(TARGET, "waiting to receive json message");
    const frame = await withContext(
      this.nextFrame(signal),
      "frame error, invalid byte length",
    );
    if (frame === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.toString("utf8"));
    } catch (error) {
      throw context(error, "unable to parse message");
    }
    try {
      return deserialize(parsed);
    } catch (error) {
      throw context(error, "unable to parse message");
    }
  }

  /**
   * Read the next null-delimited JSON instruction, with a default timeout.
   *
   * This is useful for parsing the initial message of a stream for handshake or
   * other protocol purposes, where we do not want to wait indefinitely.
   */
  async recvTimeout<T>(deserialize: (value: unknown) => T | null): Promise<T | null> {
    const result = await timeout(NETWORK_TIMEOUT, (signal) =>
      this.recv(deserialize, signal),
    );
    if (!result.ok) {
      throw new Error("timed out waiting for initial message");
    }
    return result.value;
  }

  /** Send a null-terminated JSON instruction on a stream. */
  async send(serialized: unknown): Promise<void> {
    tracing.trace(TARGET, "sending json message");
    const payload = Buffer.from(JSON.stringify(serialized), "utf8");
    const framed = this.codec.encode(payload);
    await new Promise<void>((resolve, reject) => {
      this.stream.write(framed, (error) => (error ? reject(error) : resolve()));
    });
  }

  /** Consume this object, returning current buffers and the inner transport. */
  intoParts(): FramedParts<U> {
    if (this.detached) {
      throw new Error("delimited stream has already been consumed");
    }
    this.detached = true;
    this.stream.off("data", this.onData);
    this.stream.off("end", this.onEnd);
    this.stream.off("error", this.onError);
    this.stream.pause();
    const readBuf = this.state.buf;
    this.state.buf = Buffer.alloc(0);
    // Writes are always flushed by `send`, so nothing can be pending here; the
    // callers assert this too, mirroring the Rust `debug_assert!`.
    const writeBuf = Buffer.alloc(0);
    debugAssert(writeBuf.length === 0, "framed write buffer not empty");
    return { io: this.stream, readBuf, writeBuf };
  }
}
