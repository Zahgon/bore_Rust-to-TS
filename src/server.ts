/** Server implementation for the `bore` service. */

import type net from "node:net";

import { displayError } from "./deps/anyhow.js";
import * as fastrand from "./deps/fastrand.js";
import {
  copyBidirectional,
  dropStream,
  formatSocketAddr,
  ioErrorKind,
  sleep,
  TcpListener,
  timeout,
} from "./deps/tokio.js";
import * as tracing from "./deps/tracing.js";
import * as uuid from "./deps/uuid.js";
import { Authenticator } from "./auth.js";
import { ClientMessage, CONTROL_PORT, Delimited, ServerMessage } from "./shared.js";

const TARGET = "bore_cli::server";

const UNSPECIFIED_V4 = "0.0.0.0";

/** An inclusive port range, mirroring Rust's `RangeInclusive<u16>`. */
export class PortRange {
  constructor(
    readonly start: number,
    readonly end: number,
  ) {}

  /** `RangeInclusive::is_empty`. */
  isEmpty(): boolean {
    return this.start > this.end;
  }

  /** `RangeInclusive::contains`. */
  contains(port: number): boolean {
    return port >= this.start && port <= this.end;
  }
}

/** The outcome of binding a tunnel listener: a listener, or a client-facing error. */
type CreateListenerResult =
  { ok: true; listener: TcpListener } | { ok: false; error: string };

/** State structure for the server. */
export class Server {
  /** Range of TCP ports that can be forwarded. */
  private readonly portRange: PortRange;

  /** Optional secret used to authenticate clients. */
  private readonly auth: Authenticator | null;

  /**
   * Concurrent map of IDs to incoming connections.
   *
   * `DashMap` exists to allow concurrent access from many tokio worker threads;
   * Node's single-threaded event loop makes a plain `Map` equivalent.
   */
  private readonly conns = new Map<string, net.Socket>();

  /** IP address where the control server will bind to. */
  private bindAddr: string = UNSPECIFIED_V4;

  /** IP address where tunnels will listen on. */
  private bindTunnels: string = UNSPECIFIED_V4;

  /** Every tunnel listener currently open, so shutdown can release them all. */
  private readonly listeners = new Set<TcpListener>();

  /** Create a new server with a specified minimum port number. */
  constructor(portRange: PortRange, secret?: string | null) {
    if (portRange.isEmpty()) {
      throw new Error("must provide at least one port");
    }
    this.portRange = portRange;
    this.auth =
      secret === undefined || secret === null ? null : new Authenticator(secret);
  }

  /** Set the IP address where the control server will bind to. */
  setBindAddr(bindAddr: string): void {
    this.bindAddr = bindAddr;
  }

  /** Set the IP address where tunnels will listen on. */
  setBindTunnels(bindTunnels: string): void {
    this.bindTunnels = bindTunnels;
  }

  /**
   * Start the server, listening for new connections.
   *
   * The optional signal has no counterpart in Rust, where shutting down the
   * tokio runtime aborts the task and drops every socket. TypeScript has no
   * equivalent, so cancellation is explicit; leaving it unset reproduces the
   * original run-forever behaviour exactly.
   */
  async listen(signal?: AbortSignal): Promise<void> {
    const listener = await TcpListener.bind(this.bindAddr, CONTROL_PORT);
    this.listeners.add(listener);
    tracing.info(TARGET, "server listening", { addr: this.bindAddr });

    const onAbort = () => this.shutdown();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for (;;) {
        const [stream, addr] = await listener.accept(signal);
        void tracing.instrument(
          tracing.infoSpan("control", { addr: formatSocketAddr(addr) }),
          async () => {
            tracing.info(TARGET, "incoming connection");
            try {
              await this.handleConnection(stream);
              tracing.info(TARGET, "connection exited");
            } catch (error) {
              tracing.warn(TARGET, "connection exited with error", {
                err: displayError(error),
              });
            } finally {
              // Rust drops the stream when the task ends.
              dropStream(stream);
            }
          },
        );
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.shutdown();
    }
  }

  /** Release every listener and pending connection held by this server. */
  private shutdown(): void {
    for (const listener of this.listeners) {
      listener.close();
    }
    this.listeners.clear();
    for (const [, socket] of this.conns) {
      socket.destroy();
    }
    this.conns.clear();
  }

  private async createListener(port: number): Promise<CreateListenerResult> {
    const tryBind = async (candidate: number): Promise<CreateListenerResult> => {
      try {
        const listener = await TcpListener.bind(this.bindTunnels, candidate);
        return { ok: true, listener };
      } catch (error) {
        switch (ioErrorKind(error)) {
          case "AddrInUse":
            return { ok: false, error: "port already in use" };
          case "PermissionDenied":
            return { ok: false, error: "permission denied" };
          default:
            return { ok: false, error: "failed to bind to port" };
        }
      }
    };

    if (port > 0) {
      // Client requests a specific port number.
      if (!this.portRange.contains(port)) {
        return { ok: false, error: "client port number not in allowed range" };
      }
      return tryBind(port);
    }

    // Client requests any available port in range.
    //
    // In this case, we bind to 150 random port numbers. We choose this value because in
    // order to find a free port with probability at least 1-δ, when ε proportion of the
    // ports are currently available, it suffices to check approximately -2 ln(δ) / ε
    // independently and uniformly chosen ports (up to a second-order term in ε).
    //
    // Checking 150 times gives us 99.999% success at utilizing 85% of ports under these
    // conditions, when ε=0.15 and δ=0.00001.
    for (let i = 0; i < 150; i += 1) {
      const candidate = fastrand.u16(this.portRange.start, this.portRange.end);
      const result = await tryBind(candidate);
      if (result.ok) return result;
    }
    return { ok: false, error: "failed to find an available port" };
  }

  private async handleConnection(socket: net.Socket): Promise<void> {
    const stream = new Delimited(socket);

    if (this.auth !== null) {
      try {
        await this.auth.serverHandshake(stream);
      } catch (error) {
        tracing.warn(TARGET, "server handshake failed", { err: displayError(error) });
        await stream.send(
          ServerMessage.serialize(ServerMessage.Error(displayError(error))),
        );
        return;
      }
    }

    const message = await stream.recvTimeout(ClientMessage.deserialize);
    if (message === null) {
      return;
    }

    switch (message.kind) {
      case "Authenticate": {
        tracing.warn(TARGET, "unexpected authenticate");
        return;
      }

      case "Hello": {
        const created = await this.createListener(message.value);
        if (!created.ok) {
          await stream.send(
            ServerMessage.serialize(ServerMessage.Error(created.error)),
          );
          return;
        }
        const listener = created.listener;
        this.listeners.add(listener);
        try {
          const host = listener.localAddr().ip;
          const port = listener.localAddr().port;
          tracing.info(TARGET, "new client", { host, port: String(port) });
          await stream.send(ServerMessage.serialize(ServerMessage.Hello(port)));

          for (;;) {
            try {
              await stream.send(ServerMessage.serialize(ServerMessage.Heartbeat));
            } catch {
              // Assume that the TCP connection has been dropped.
              return;
            }
            const TIMEOUT = 500;
            const result = await timeout(TIMEOUT, (signal) => listener.accept(signal));
            if (result.ok) {
              const [stream2, addr] = result.value;
              tracing.info(TARGET, "new connection", {
                addr: formatSocketAddr(addr),
                port: String(port),
              });

              const id = uuid.newV4();
              const conns = this.conns;

              conns.set(id, stream2);
              void (async () => {
                // Remove stale entries to avoid memory leaks.
                await sleep(10_000, undefined, true);
                if (conns.delete(id)) {
                  tracing.warn(TARGET, "removed stale connection", { id });
                }
              })();
              await stream.send(ServerMessage.serialize(ServerMessage.Connection(id)));
            }
          }
        } finally {
          this.listeners.delete(listener);
          listener.close();
        }
      }

      case "Accept": {
        const id = message.value;
        tracing.info(TARGET, "forwarding connection", { id });
        const stream2 = this.conns.get(id);
        if (stream2 !== undefined) {
          this.conns.delete(id);
          const parts = stream.intoParts();
          try {
            if (parts.readBuf.length > 0) {
              await new Promise<void>((resolve, reject) => {
                stream2.write(parts.readBuf, (error) =>
                  error ? reject(error) : resolve(),
                );
              });
            }
            await copyBidirectional(parts.io, stream2);
          } finally {
            dropStream(stream2);
          }
        } else {
          tracing.warn(TARGET, "missing connection", { id });
        }
        return;
      }
    }
  }
}
