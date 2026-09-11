/**
 * Error and lifetime paths that the protocol tests never reach.
 *
 * `bore` reaches these through ordinary use — a bind address chosen on the
 * command line, a socket that errors mid-frame, a background timer that must
 * not hold the process open — but the end-to-end tests only exercise the happy
 * path, so each is asserted directly here against the Rust behaviour it ports.
 */

import net from "node:net";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";

import { ClapError } from "../src/deps/clap.js";
import { TcpListener, copyBidirectional, sleep } from "../src/deps/tokio.js";
import { Delimited } from "../src/shared.js";
import { PortRange, Server } from "../src/server.js";

test("bind addresses are configurable after construction", () => {
  // Rust: `Server::set_bind_addr` / `set_bind_tunnels`, driven by --bind-addr
  // and --bind-tunnels. Defaults stay in place until explicitly overridden.
  const server = new Server(new PortRange(1024, 65535), null);

  server.setBindAddr("127.0.0.1");
  server.setBindTunnels("0.0.0.0");

  // Both fields are private, as they are in Rust; the stored values are read
  // back through a cast because the addresses are only otherwise observable
  // by binding real ports, which collides with the fixed control port.
  const configured = server as unknown as { bindAddr: string; bindTunnels: string };
  expect(configured.bindAddr).toBe("127.0.0.1");
  expect(configured.bindTunnels).toBe("0.0.0.0");
});

test("a socket error surfaces as a rejected recv, not a hang", async () => {
  // Rust: the framed stream yields Err(...) and the caller propagates it.
  // Without the error listener the event is swallowed and recv() waits forever.
  const listener = net.createServer();
  const port = await new Promise<number>((resolve) => {
    listener.listen(0, "127.0.0.1", () =>
      resolve((listener.address() as net.AddressInfo).port),
    );
  });
  const socket = net.connect({ host: "127.0.0.1", port });
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));

  const delimited = new Delimited(socket);
  // `recv` needs a deserialiser; it never runs here because the socket dies first.
  const pending = delimited.recv((value) => value);

  socket.destroy(new Error("connection reset by peer"));

  // Rust wraps this with `.context("frame error, invalid byte length")`, so the
  // socket failure arrives as the cause rather than as the top-level message.
  await expect(pending).rejects.toThrow("frame error, invalid byte length");
  await pending.catch((error: unknown) => {
    expect((error as { cause?: Error }).cause?.message).toBe("connection reset by peer");
  });
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});

test("copyBidirectional rejects when one side errors", async () => {
  // Rust: tokio::io::copy_bidirectional returns Err, and bore lets the
  // connection task die with it rather than treating the copy as complete.
  const left = new PassThrough();
  const right = new PassThrough();
  const copying = copyBidirectional(left, right);

  left.emit("error", new Error("broken pipe"));

  await expect(copying).rejects.toThrow("broken pipe");
});

test("an unreferenced sleep still resolves", async () => {
  // Rust: a heartbeat task simply dies with the runtime. The Node equivalent
  // unrefs the timer so it cannot keep the process alive, which must not stop
  // it resolving while the process is up.
  const before = Date.now();
  await sleep(20, undefined, true);
  expect(Date.now() - before).toBeGreaterThanOrEqual(15);
});

test("sleep rejects once its signal aborts", async () => {
  const controller = new AbortController();
  const pending = sleep(10_000, controller.signal);

  controller.abort();

  await expect(pending).rejects.toThrow();
});

test("connecting to a closed port reports the failure", async () => {
  // Exercises the connect error path: a port nothing listens on.
  const probe = net.createServer();
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, "127.0.0.1", () => resolve((probe.address() as net.AddressInfo).port));
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const { tcpConnect } = await import("../src/deps/tokio.js");
  await expect(tcpConnect("127.0.0.1", port)).rejects.toThrow();
});

test("a listener can stop holding the event loop open", async () => {
  // Rust drops the listener with the runtime; Node needs an explicit unref so
  // an idle listener does not keep the process alive.
  const listener = await TcpListener.bind("127.0.0.1", 0);
  expect(() => listener.unref()).not.toThrow();
  // Still usable afterwards: unref changes lifetime, not behaviour.
  expect(listener.localAddr().port).toBeGreaterThan(0);
  listener.close();
});

test("ClapError.exit writes to its stream and exits with its code", () => {
  // Rust: `clap::Error::exit()`. Both the stream choice and the exit code are
  // part of the CLI contract, so they are asserted without ending the process.
  const error = new ClapError("error: bad argument", 2, "stderr");
  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalExit = process.exit.bind(process);
  let exitCode: number | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string): boolean => {
    written.push(chunk);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (code?: number): never => {
    exitCode = code;
    throw new Error("exited");
  };

  try {
    expect(() => error.exit()).toThrow("exited");
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = originalWrite;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).exit = originalExit;
  }

  expect(written).toEqual(["error: bad argument\n"]);
  expect(exitCode).toBe(2);
});
