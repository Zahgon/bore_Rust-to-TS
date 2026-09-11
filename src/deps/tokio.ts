/**
 * Port of the `tokio` primitives that `bore` uses: timeouts, sleeps, an
 * in-memory duplex pipe, a bidirectional copy that preserves half-close, and a
 * TCP listener with an awaitable `accept()`.
 */

import dns from "node:dns/promises";
import net from "node:net";
import { Duplex, PassThrough } from "node:stream";

/** `tokio::time::sleep`. */
export function sleep(ms: number, signal?: AbortSignal, unref = false): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // A background timer should not keep the process alive on its own, matching
    // a tokio task that simply dies with the runtime.
    if (unref) timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The `Result<T, Elapsed>` that `tokio::time::timeout` returns. */
export type Timeout<T> = { ok: true; value: T } | { ok: false };

/**
 * `tokio::time::timeout(duration, future)`.
 *
 * The inner work is expressed as a function of an `AbortSignal` so that a
 * timeout genuinely *cancels* it, the way Rust drops the pending future. This
 * matters for `accept()` and `recv()`: an abandoned-but-still-running read
 * would steal the next connection or frame from the caller that follows.
 */
export async function timeout<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<Timeout<T>> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<Timeout<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false });
    }, ms);
  });
  // Once we have aborted, an inner rejection is just the cancellation surfacing;
  // Rust drops the future silently, so we swallow it rather than leaving an
  // unhandled rejection behind.
  const task = run(controller.signal).then(
    (value): Timeout<T> => ({ ok: true, value }),
    (error: unknown): Timeout<T> => {
      if (controller.signal.aborted) return { ok: false };
      throw error;
    },
  );
  try {
    return await Promise.race([task, elapsed]);
  } finally {
    clearTimeout(timer);
  }
}

/** The error produced when an `AbortSignal` fires. */
export function abortError(): Error {
  const error = new Error("operation was cancelled");
  (error as NodeJS.ErrnoException).code = "ABORT_ERR";
  return error;
}

/** `std::io::ErrorKind`, restricted to the variants `bore` matches on. */
export type IoErrorKind = "AddrInUse" | "PermissionDenied" | "Other";

/** Classify a Node error the way Rust classifies `io::Error::kind()`. */
export function ioErrorKind(error: unknown): IoErrorKind {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "EADDRINUSE":
      return "AddrInUse";
    case "EACCES":
    case "EPERM":
      return "PermissionDenied";
    default:
      return "Other";
  }
}

/**
 * `tokio::io::duplex(max_buf_size)` — a pair of connected in-memory streams.
 *
 * Writes on one side become reads on the other, with a bounded buffer, so the
 * capacity-sensitive behaviour the auth tests exercise is preserved.
 */
export function duplex(maxBufSize: number): [Duplex, Duplex] {
  const aToB = new PassThrough({ highWaterMark: maxBufSize });
  const bToA = new PassThrough({ highWaterMark: maxBufSize });
  return [duplexSide(bToA, aToB), duplexSide(aToB, bToA)];
}

function duplexSide(incoming: PassThrough, outgoing: PassThrough): Duplex {
  const side = new Duplex({
    allowHalfOpen: true,
    read() {
      incoming.resume();
    },
    write(chunk, _encoding, callback) {
      outgoing.write(chunk, (error) => callback(error ?? null));
    },
    final(callback) {
      outgoing.end();
      callback();
    },
  });
  incoming.on("data", (chunk: Buffer) => {
    if (!side.push(chunk)) {
      incoming.pause();
    }
  });
  incoming.on("end", () => {
    side.push(null);
  });
  incoming.on("error", (error) => {
    side.destroy(error);
  });
  return side;
}

/**
 * `tokio::io::copy_bidirectional(a, b)`.
 *
 * Copies in both directions until *both* are exhausted, and — critically —
 * propagates EOF as a write-side shutdown rather than a full close, so a
 * half-closed TCP stream stays open in the other direction. Resolves with the
 * bytes copied `(a -> b, b -> a)`; rejects if either direction errors, matching
 * Rust's `Result` propagation.
 */
export function copyBidirectional(a: Duplex, b: Duplex): Promise<[number, number]> {
  return Promise.all([copyOneWay(a, b), copyOneWay(b, a)]);
}

function copyOneWay(source: Duplex, destination: Duplex): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let copied = 0;
    let settled = false;

    const cleanup = () => {
      source.off("data", onData);
      source.off("end", onEnd);
      source.off("error", onError);
      destination.off("error", onError);
      destination.off("close", onDestinationClose);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(copied);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    function onData(chunk: Buffer) {
      copied += chunk.length;
      if (destination.writableEnded || destination.destroyed) {
        // The peer is gone; stop pulling rather than throwing a write-after-end.
        succeed();
        return;
      }
      if (!destination.write(chunk)) {
        source.pause();
        destination.once("drain", () => source.resume());
      }
    }
    function onEnd() {
      // Shut down only the write half, leaving the reverse direction usable.
      if (!destination.writableEnded && !destination.destroyed) {
        destination.end();
      }
      succeed();
    }
    function onError(error: Error) {
      fail(error);
    }
    function onDestinationClose() {
      succeed();
    }

    source.on("data", onData);
    source.on("end", onEnd);
    source.on("error", onError);
    destination.on("error", onError);
    destination.on("close", onDestinationClose);

    if (source.readableEnded) {
      onEnd();
      return;
    }
    // `Delimited.intoParts` explicitly pauses the stream to stop consuming
    // frames. Node will not auto-resume an explicitly paused stream when a
    // "data" listener is attached, so flow has to be restarted by hand — this
    // copy is the active reader now, mirroring tokio polling the socket.
    source.resume();
  });
}

/** A bound TCP address, mirroring `std::net::SocketAddr`. */
export interface SocketAddr {
  ip: string;
  port: number;
}

/** Render a `SocketAddr` the way Rust's `Debug`/`Display` impl does. */
export function formatSocketAddr(addr: SocketAddr): string {
  return addr.ip.includes(":")
    ? `[${addr.ip}]:${addr.port}`
    : `${addr.ip}:${addr.port}`;
}

/**
 * `tokio::net::TcpListener`.
 *
 * Incoming connections are queued exactly like the kernel backlog, so an
 * `accept()` that is cancelled by a timeout does not drop the connection — the
 * next `accept()` picks it up.
 */
export class TcpListener {
  private readonly queue: Array<[net.Socket, SocketAddr]> = [];
  private readonly waiters: Array<{
    resolve: (value: [net.Socket, SocketAddr]) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort: () => void;
  }> = [];
  private closed = false;

  private constructor(private readonly server: net.Server) {
    server.on("connection", (socket) => {
      const addr: SocketAddr = {
        ip: socket.remoteAddress ?? "",
        port: socket.remotePort ?? 0,
      };
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        waiter.resolve([socket, addr]);
      } else {
        this.queue.push([socket, addr]);
      }
    });
    server.on("error", (error) => {
      const waiters = this.waiters.splice(0, this.waiters.length);
      for (const waiter of waiters) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        waiter.reject(error);
      }
    });
  }

  /** `TcpListener::bind((addr, port))`. */
  static bind(host: string, port: number): Promise<TcpListener> {
    return new Promise((resolve, reject) => {
      const server = net.createServer({ allowHalfOpen: true, noDelay: true });
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(new TcpListener(server));
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host, port });
    });
  }

  /** `TcpListener::accept()`; abort the signal to cancel the pending accept. */
  accept(signal?: AbortSignal): Promise<[net.Socket, SocketAddr]> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const waiter = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError());
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  /** `TcpListener::local_addr()`. */
  localAddr(): SocketAddr {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("listener is not bound to a TCP address");
    }
    return { ip: address.address, port: address.port };
  }

  /**
   * Release the listener.
   *
   * Rust reclaims the socket when the `TcpListener` is dropped; TypeScript has
   * no destructor, so shutdown is explicit. Queued-but-unaccepted connections
   * are destroyed, which is what dropping the listener does.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [socket] of this.queue.splice(0, this.queue.length)) {
      socket.destroy();
    }
    for (const waiter of this.waiters.splice(0, this.waiters.length)) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(abortError());
    }
    this.server.close();
  }

  /** Stop the listener from holding the event loop open. */
  unref(): void {
    this.server.unref();
  }
}

/** `TcpStream::connect((host, port))`. */
export function tcpConnect(
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<net.Socket> {
  return (async () => {
    // Rust's `ToSocketAddrs` resolves a host to *every* address and
    // `TcpStream::connect` tries each in turn until one succeeds. Node's
    // `net.connect` commits to a single address, so a host like "localhost"
    // that resolves to both ::1 and 127.0.0.1 fails outright whenever the
    // listener bound only the other family. Resolve and walk the list to
    // reproduce the Rust behaviour.
    const addresses = await resolveAddresses(host);
    let lastError: Error | null = null;
    for (const address of addresses) {
      if (signal?.aborted) throw abortError();
      try {
        return await connectTo(address, port, signal);
      } catch (error) {
        if ((error as Error).name === "AbortError") throw error;
        lastError = error as Error;
      }
    }
    throw lastError ?? new Error(`could not resolve ${host}`);
  })();
}

/**
 * Every address `host` resolves to, in resolver order, mirroring
 * `ToSocketAddrs`. IP literals are returned as-is; a resolver failure falls
 * back to the original string so the connect attempt reports the real error.
 */
async function resolveAddresses(host: string): Promise<string[]> {
  if (net.isIP(host) !== 0) return [host];
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    return records.length > 0 ? records.map((record) => record.address) : [host];
  } catch {
    return [host];
  }
}

/** A single `net.connect` attempt against one already-resolved address. */
function connectTo(
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let socket: net.Socket;
    try {
      socket = net.connect({ host, port, allowHalfOpen: true, noDelay: true });
    } catch (error) {
      reject(error as Error);
      return;
    }
    const onAbort = () => {
      socket.destroy();
      reject(abortError());
    };
    const onError = (error: Error) => {
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      reject(error);
    };
    const onConnect = () => {
      signal?.removeEventListener("abort", onAbort);
      socket.off("error", onError);
      resolve(socket);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

/**
 * Close a stream the way Rust closes one when the value is dropped: flush any
 * pending writes, then release the socket entirely.
 *
 * A bare `end()` would only half-close, leaving the peer able to keep writing;
 * Rust's `close(2)` makes further inbound data reset the connection, which the
 * "very long frame" test depends on.
 */
export function dropStream(stream: Duplex): void {
  if (stream.destroyed) return;
  if (stream.writableFinished) {
    stream.destroy();
    return;
  }
  stream.once("finish", () => stream.destroy());
  stream.once("error", () => stream.destroy());
  if (!stream.writableEnded) {
    stream.end();
  }
}
