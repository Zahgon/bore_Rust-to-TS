/**
 * Server behaviour observed over the raw control protocol.
 *
 * These assert bytes on the wire rather than internal state, because the error
 * strings and the heartbeat are part of the protocol contract with the Rust
 * implementation. Every expectation here was verified against the running Rust
 * server with the same raw-socket probe.
 *
 * Mutation testing motivated this file: changing the "not in allowed range"
 * error text, or removing the heartbeat entirely, previously broke nothing.
 */

import net from "node:net";
import { afterEach, expect, test } from "vitest";

import { sleep } from "../src/deps/tokio.js";
import { Mutex } from "../src/deps/sync.js";
import { PortRange, Server } from "../src/server.js";
import { ClientMessage, CONTROL_PORT } from "../src/shared.js";

const SERIAL_GUARD = new Mutex();
const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.();
  await sleep(30);
});

async function startServer(
  range = new PortRange(1024, 65535),
  secret: string | null = null,
) {
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  const server = new Server(range, secret);
  void server.listen(controller.signal).catch(() => {});
  await sleep(60);
}

/** A raw control connection that decodes NUL-delimited frames. */
class Control {
  readonly frames: string[] = [];
  closed = false;
  constructor(private readonly socket: net.Socket) {
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const i = buf.indexOf(0);
        if (i === -1) break;
        this.frames.push(buf.subarray(0, i).toString());
        buf = buf.subarray(i + 1);
      }
    });
    socket.on("error", () => {
      this.closed = true;
    });
    socket.on("close", () => {
      this.closed = true;
    });
    socket.on("end", () => {
      this.closed = true;
    });
  }
  static connect(): Promise<Control> {
    return new Promise((resolve, reject) => {
      const s = net.connect({
        host: "127.0.0.1",
        port: CONTROL_PORT,
        allowHalfOpen: true,
      });
      s.once("connect", () => resolve(new Control(s)));
      s.once("error", reject);
    });
  }
  send(message: ClientMessage): void {
    this.socket.write(
      Buffer.concat([
        Buffer.from(JSON.stringify(ClientMessage.serialize(message))),
        Buffer.from([0]),
      ]),
    );
  }
  /** Frames other than heartbeats, which arrive continuously. */
  get messages(): string[] {
    return this.frames.filter((f) => f !== '"Heartbeat"');
  }
  get heartbeats(): number {
    return this.frames.filter((f) => f === '"Heartbeat"').length;
  }
  async waitForMessage(ms = 3000): Promise<string | undefined> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && this.messages.length === 0 && !this.closed) {
      await sleep(10);
    }
    return this.messages[0];
  }
  destroy(): void {
    this.socket.destroy();
  }
}

test("rejects a port outside the allowed range with the exact wire message", async () => {
  const release = await SERIAL_GUARD.lock();
  try {
    await startServer(new PortRange(40000, 41000));
    const control = await Control.connect();
    control.send(ClientMessage.Hello(100));
    // The literal text matters: the client surfaces it verbatim as
    // "server error: <message>", and the Rust server emits this exact string.
    expect(await control.waitForMessage()).toBe(
      JSON.stringify({ Error: "client port number not in allowed range" }),
    );
    control.destroy();
  } finally {
    release();
  }
});

test("reports a port already in use with the exact wire message", async () => {
  const release = await SERIAL_GUARD.lock();
  try {
    await startServer();
    const control = await Control.connect();
    // The control port itself is in range but already bound by the server.
    control.send(ClientMessage.Hello(CONTROL_PORT));
    expect(await control.waitForMessage()).toBe(
      JSON.stringify({ Error: "port already in use" }),
    );
    control.destroy();
  } finally {
    release();
  }
});

test("assigns a port inside the configured range", async () => {
  const release = await SERIAL_GUARD.lock();
  try {
    await startServer(new PortRange(45000, 45500));
    const control = await Control.connect();
    control.send(ClientMessage.Hello(0));
    const reply = await control.waitForMessage();
    const parsed = JSON.parse(reply as string) as { Hello: number };
    expect(parsed.Hello).toBeGreaterThanOrEqual(45000);
    expect(parsed.Hello).toBeLessThanOrEqual(45500);
    control.destroy();
  } finally {
    release();
  }
});

test("honours a specific in-range port request", async () => {
  const release = await SERIAL_GUARD.lock();
  try {
    await startServer(new PortRange(1024, 65535));
    const control = await Control.connect();
    control.send(ClientMessage.Hello(46999));
    expect(await control.waitForMessage()).toBe(JSON.stringify({ Hello: 46999 }));
    control.destroy();
  } finally {
    release();
  }
});

// The heartbeat is how the server notices a dead client; without it the accept
// loop would block forever and the connection would never be reclaimed.
test("emits heartbeats about every 500ms once a tunnel is open", async () => {
  const release = await SERIAL_GUARD.lock();
  try {
    await startServer();
    const control = await Control.connect();
    control.send(ClientMessage.Hello(0));
    expect(await control.waitForMessage()).toMatch(/"Hello"/);

    const before = control.heartbeats;
    await sleep(1600);
    const elapsed = control.heartbeats - before;
    // ~3 expected in 1.6s; assert a band rather than an exact count.
    expect(elapsed).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThanOrEqual(6);
    control.destroy();
  } finally {
    release();
  }
});

test("closes the connection when asked to accept an unknown id", async () => {
  const release = await SERIAL_GUARD.lock();
  try {
    await startServer();
    const control = await Control.connect();
    control.send(ClientMessage.Accept("550e8400-e29b-41d4-a716-446655440000"));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !control.closed) await sleep(10);
    expect(control.closed).toBe(true);
    expect(control.messages).toEqual([]);
    control.destroy();
  } finally {
    release();
  }
});

test("closes the connection on an unexpected Authenticate", async () => {
  const release = await SERIAL_GUARD.lock();
  try {
    await startServer();
    const control = await Control.connect();
    control.send(ClientMessage.Authenticate("deadbeef"));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !control.closed) await sleep(10);
    expect(control.closed).toBe(true);
    expect(control.messages).toEqual([]);
    control.destroy();
  } finally {
    release();
  }
});

test("rejects a bad secret with the exact wire message", async () => {
  const release = await SERIAL_GUARD.lock();
  try {
    await startServer(new PortRange(1024, 65535), "the-real-secret");
    const control = await Control.connect();
    // The server opens with a Challenge; answer it with a wrong tag.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && control.messages.length === 0) await sleep(10);
    expect(control.messages[0]).toMatch(/"Challenge"/);
    control.send(ClientMessage.Authenticate("00".repeat(32)));
    const after = Date.now() + 3000;
    while (Date.now() < after && control.messages.length < 2) await sleep(10);
    expect(control.messages[1]).toBe(JSON.stringify({ Error: "invalid secret" }));
    control.destroy();
  } finally {
    release();
  }
});
