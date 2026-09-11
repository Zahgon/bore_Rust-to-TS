import net from "node:net";
import { afterEach, expect, test } from "vitest";

import { Client } from "../src/client.js";
import { sleep, TcpListener, tcpConnect } from "../src/deps/tokio.js";
import { Mutex } from "../src/deps/sync.js";
import { PortRange, Server } from "../src/server.js";
import { CONTROL_PORT } from "../src/shared.js";

/** Guard to make sure that tests are run serially, not concurrently. */
const SERIAL_GUARD = new Mutex();

/**
 * Everything a test spawned, torn down afterwards.
 *
 * Rust gets this for free: each `#[tokio::test]` owns a runtime, and dropping it
 * aborts every spawned task and closes every socket. TypeScript has no such
 * scope, so the teardown is explicit — otherwise the next test could not rebind
 * the fixed `CONTROL_PORT`.
 */
const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    cleanup?.();
  }
  // Give the event loop a tick to actually release the listening sockets.
  await sleep(20);
});

/** Spawn the server, giving some time for the control port TcpListener to start. */
async function spawnServer(secret: string | null): Promise<void> {
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  const server = new Server(new PortRange(1024, 65535), secret);
  void server.listen(controller.signal).catch(() => {
    // The task is aborted at teardown; Rust simply drops it.
  });
  await sleep(50);
}

/** Spawns a client with randomly assigned ports, returning the listener and remote address. */
async function spawnClient(
  secret: string | null,
): Promise<{ listener: TcpListener; remoteAddr: { host: string; port: number } }> {
  const listener = await TcpListener.bind("localhost", 0);
  const localPort = listener.localAddr().port;
  let client: Client;
  try {
    client = await Client.new("localhost", localPort, "localhost", 0, secret);
  } catch (error) {
    listener.close();
    throw error;
  }
  const remoteAddr = { host: "127.0.0.1", port: client.remotePort() };
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  void client.listen(controller.signal).catch(() => {
    // Aborted at teardown.
  });
  return { listener, remoteAddr };
}

/**
 * Buffered reader over a socket, standing in for `tokio::io::AsyncReadExt`.
 *
 * `readExact` mirrors `read_exact` (erroring on a short read) and `read`
 * mirrors `read`, returning `0` at EOF.
 */
class Reader {
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;
  private failure: Error | null = null;
  private waiter: (() => void) | null = null;

  constructor(socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.wake();
    });
    socket.on("end", () => {
      this.ended = true;
      this.wake();
    });
    socket.on("error", (error: Error) => {
      this.failure = error;
      this.ended = true;
      this.wake();
    });
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  private ready(): Promise<void> {
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /** `AsyncReadExt::read_exact`. */
  async readExact(length: number): Promise<Buffer> {
    while (this.buf.length < length) {
      if (this.ended) {
        throw this.failure ?? new Error("early eof");
      }
      await this.ready();
    }
    const out = this.buf.subarray(0, length);
    this.buf = this.buf.subarray(length);
    return out;
  }

  /** `AsyncReadExt::read`; resolves to the byte count, `0` meaning EOF. */
  async read(max: number): Promise<number> {
    while (this.buf.length === 0) {
      if (this.ended) return 0;
      await this.ready();
    }
    const take = Math.min(max, this.buf.length);
    this.buf = this.buf.subarray(take);
    return take;
  }
}

/** `AsyncWriteExt::write_all`. */
function writeAll(socket: net.Socket, data: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

/** Connect to a `host:port` pair, as `TcpStream::connect(addr)` does. */
function connect(addr: { host: string; port: number }): Promise<net.Socket> {
  return tcpConnect(addr.host, addr.port);
}

// `test.each` with `$name` renders a string value in quotes, so the case would
// be titled `basic_proxy::'secret_1'` where rstest generates `basic_proxy::
// secret_1`. The title is built explicitly so the ported names match the
// originals verbatim.
for (const { name, secret } of [
  { name: "secret_1", secret: null as string | null },
  { name: "secret_2", secret: "" as string | null },
  { name: "secret_3", secret: "abc" as string | null },
]) {
  test(`basic_proxy::${name}`, async () => {
    const release = await SERIAL_GUARD.lock();
    try {
      await spawnServer(secret);
      const { listener, remoteAddr } = await spawnClient(secret);

      // Handles exactly one connection, then drops both the stream and the
      // listener — which is what makes the second connection below fail.
      //
      // A failure in here would otherwise only show up as the main flow hanging,
      // because Rust likewise discards the spawned task's result. The error is
      // captured and re-raised at the end so the message survives.
      let backgroundError: unknown = null;
      const service = (async () => {
        const [inbound] = await listener.accept();
        const reader = new Reader(inbound);
        const buf = await reader.readExact(11);
        expect(buf).toEqual(Buffer.from("hello world"));

        await writeAll(inbound, "I can send a message too!");
        inbound.end();
        listener.close();
      })().catch((error: unknown) => {
        backgroundError = error;
      });

      const stream = await connect(remoteAddr);
      const reader = new Reader(stream);
      await writeAll(stream, "hello world");

      const buf = await reader.readExact(25);
      expect(buf).toEqual(Buffer.from("I can send a message too!"));

      // Ensure that the client end of the stream is closed now.
      expect(await reader.read(25)).toBe(0);

      // Also ensure that additional connections do not produce any data.
      const stream2 = await connect(remoteAddr);
      const reader2 = new Reader(stream2);
      expect(await reader2.read(25)).toBe(0);

      stream.destroy();
      stream2.destroy();

      await service;
      if (backgroundError !== null) throw backgroundError;
    } finally {
      release();
    }
  });
}

for (const { name, serverSecret, clientSecret } of [
  {
    name: "case_1",
    serverSecret: null as string | null,
    clientSecret: "my secret" as string | null,
  },
  {
    name: "case_2",
    serverSecret: "my secret" as string | null,
    clientSecret: null as string | null,
  },
]) {
  test(`mismatched_secret::${name}`, async () => {
    const release = await SERIAL_GUARD.lock();
    try {
      await spawnServer(serverSecret);

      // Rust asserts only `is_err()`. We check *which* error, but not too tightly:
      // when the client holds a secret the server does not, both peers sit on a
      // 3s `recv_timeout` and whichever fires first decides the message. That race
      // is inherent to the original design — the Rust binary produces both
      // outcomes across repeated runs — so a single expected string would be
      // flaky. Asserting the set still catches a crash, a refused connection, or
      // the wrong protocol error, which a bare `.toThrow()` would not.
      const allowed =
        clientSecret === null
          ? ["server requires authentication, but no client secret was provided"]
          : [
              "expected authentication challenge, but no secret was required",
              "timed out waiting for initial message",
            ];
      await expect(spawnClient(clientSecret)).rejects.toThrow(
        new RegExp(
          allowed.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
        ),
      );
    } finally {
      release();
    }
  });
}

test("invalid_address", async () => {
  // We don't need the serial guard for this test because it doesn't create a server.
  async function checkAddress(to: string, useSecret: boolean): Promise<void> {
    let client: Client;
    try {
      client = await Client.new(
        "localhost",
        5000,
        to,
        0,
        useSecret ? "a secret" : null,
      );
    } catch {
      return;
    }
    void client;
    throw new Error(`expected error for ${to}, use_secret=${useSecret}`);
  }
  await Promise.all([
    checkAddress("google.com", false),
    checkAddress("google.com", true),
    checkAddress("nonexistent.domain.for.demonstration", false),
    checkAddress("nonexistent.domain.for.demonstration", true),
    checkAddress("malformed !$uri$%", false),
    checkAddress("malformed !$uri$%", true),
  ]);
});

test("very_long_frame", async () => {
  const release = await SERIAL_GUARD.lock();
  try {
    await spawnServer(null);
    const attacker = await tcpConnect("localhost", CONTROL_PORT);

    let failed = false;
    let serverClosed = false;
    attacker.on("error", () => {
      failed = true;
    });
    // The server drops the connection once the framer rejects the oversized
    // chunk, which surfaces here as EOF, close, or a failing write.
    attacker.on("end", () => {
      serverClosed = true;
    });
    attacker.on("close", () => {
      serverClosed = true;
    });

    // Slowly send a very long frame.
    let iterations = 0;
    for (let i = 0; i < 10; i += 1) {
      iterations += 1;
      try {
        await writeAll(attacker, Buffer.alloc(100_000, 42));
      } catch {
        failed = true;
      }
      if (failed || attacker.destroyed || serverClosed) {
        break;
      }
      await sleep(10);
    }
    attacker.destroy();

    // Assert *why* the loop ended, not merely that it ended: without this the
    // test would pass vacuously on any early return.
    expect(failed || serverClosed).toBe(true);
    expect(iterations).toBeLessThan(10);
  } finally {
    release();
  }
});

test("empty_port_range", () => {
  const minPort = 5000;
  const maxPort = 3000;
  expect(() => new Server(new PortRange(minPort, maxPort), null)).toThrow(
    "must provide at least one port",
  );
});

test("half_closed_tcp_stream", async () => {
  // Check that "half-closed" TCP streams will not result in spontaneous hangups.
  const release = await SERIAL_GUARD.lock();
  try {
    await spawnServer(null);
    const { listener, remoteAddr } = await spawnClient(null);

    const [cli, [srv]] = await Promise.all([connect(remoteAddr), listener.accept()]);
    const cliReader = new Reader(cli);
    const srvReader = new Reader(srv);

    // Send data before half-closing one of the streams.
    await writeAll(cli, "message before shutdown");

    // Only close the write half of the stream. This is a half-closed stream. In the
    // TCP protocol, it is represented as a FIN packet on one end. The entire stream
    // is only closed after two FINs are exchanged and ACKed by the other end.
    cli.end();

    expect(await srvReader.readExact(23)).toEqual(
      Buffer.from("message before shutdown"),
    );
    expect(await srvReader.read(23)).toBe(0); // EOF

    // Now make sure that the other stream can still send data, despite
    // half-shutdown on client->server side.
    await writeAll(srv, "hello from the other side!");
    expect(await cliReader.readExact(26)).toEqual(
      Buffer.from("hello from the other side!"),
    );

    // We don't have to think about CLOSE_RD handling because that's not really
    // part of the TCP protocol, just the POSIX streams API. It is implemented by
    // the OS ignoring future packets received on that stream.

    cli.destroy();
    srv.destroy();
    listener.close();
  } finally {
    release();
  }
});
