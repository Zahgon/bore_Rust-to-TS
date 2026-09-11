/** Client implementation for the `bore` service. */

import type net from "node:net";

import { bail, displayError, withContext } from "./deps/anyhow.js";
import { copyBidirectional, dropStream, tcpConnect, timeout } from "./deps/tokio.js";
import * as tracing from "./deps/tracing.js";
import { Authenticator } from "./auth.js";
import {
  ClientMessage,
  CONTROL_PORT,
  Delimited,
  NETWORK_TIMEOUT,
  ServerMessage,
} from "./shared.js";

const TARGET = "bore_cli::client";

/** State structure for the client. */
export class Client {
  /** Control connection to the server. */
  private conn: Delimited<net.Socket> | null;

  /** Destination address of the server. */
  private readonly to: string;

  /** Local host that is forwarded. */
  private readonly localHost: string;

  /** Local port that is forwarded. */
  private readonly localPort: number;

  /** Port that is publicly available on the remote. */
  private readonly _remotePort: number;

  /** Optional secret used to authenticate clients. */
  private readonly auth: Authenticator | null;

  /** Sockets currently being proxied, so shutdown can release them. */
  private readonly active = new Set<net.Socket>();

  private constructor(init: {
    conn: Delimited<net.Socket>;
    to: string;
    localHost: string;
    localPort: number;
    remotePort: number;
    auth: Authenticator | null;
  }) {
    this.conn = init.conn;
    this.to = init.to;
    this.localHost = init.localHost;
    this.localPort = init.localPort;
    this._remotePort = init.remotePort;
    this.auth = init.auth;
  }

  /**
   * Create a new client.
   *
   * Rust's `Client::new` is an async constructor; TypeScript constructors
   * cannot await, so this is a static factory with the same name and signature.
   */
  static async new(
    localHost: string,
    localPort: number,
    to: string,
    port: number,
    secret?: string | null,
  ): Promise<Client> {
    const stream = new Delimited(await connectWithTimeout(to, CONTROL_PORT));
    const auth =
      secret === undefined || secret === null ? null : new Authenticator(secret);
    if (auth !== null) {
      await auth.clientHandshake(stream);
    }

    await stream.send(ClientMessage.serialize(ClientMessage.Hello(port)));
    const message = await stream.recvTimeout(ServerMessage.deserialize);
    let remotePort: number;
    if (message === null) {
      bail("unexpected EOF");
    } else if (message.kind === "Hello") {
      remotePort = message.value;
    } else if (message.kind === "Error") {
      bail(`server error: ${message.value}`);
    } else if (message.kind === "Challenge") {
      bail("server requires authentication, but no client secret was provided");
    } else {
      bail("unexpected initial non-hello message");
    }
    tracing.info(TARGET, "connected to server", { remote_port: String(remotePort) });
    tracing.info(TARGET, `listening at ${to}:${remotePort}`);

    return new Client({ conn: stream, to, localHost, localPort, remotePort, auth });
  }

  /** Returns the port publicly available on the remote. */
  remotePort(): number {
    return this._remotePort;
  }

  /**
   * Start the client, listening for new connections.
   *
   * As with the server, the optional signal replaces dropping the tokio
   * runtime; without it the loop runs until the server closes the connection.
   */
  async listen(signal?: AbortSignal): Promise<void> {
    const conn = this.conn;
    if (conn === null) {
      throw new Error("client has already been consumed");
    }
    this.conn = null;

    const onAbort = () => {
      dropStream(conn.io);
      for (const socket of this.active) socket.destroy();
      this.active.clear();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for (;;) {
        const message = await conn.recv(ServerMessage.deserialize, signal);
        if (message === null) {
          return;
        }
        switch (message.kind) {
          case "Hello":
            tracing.warn(TARGET, "unexpected hello");
            break;
          case "Challenge":
            tracing.warn(TARGET, "unexpected challenge");
            break;
          case "Heartbeat":
            break;
          case "Connection": {
            const id = message.value;
            void tracing.instrument(tracing.infoSpan("proxy", { id }), async () => {
              tracing.info(TARGET, "new connection");
              try {
                await this.handleConnection(id);
                tracing.info(TARGET, "connection exited");
              } catch (error) {
                tracing.warn(TARGET, "connection exited with error", {
                  err: displayError(error),
                });
              }
            });
            break;
          }
          case "Error":
            tracing.error(TARGET, "server error", { err: message.value });
            break;
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      dropStream(conn.io);
    }
  }

  private async handleConnection(id: string): Promise<void> {
    const remoteConn = new Delimited(await connectWithTimeout(this.to, CONTROL_PORT));
    this.active.add(remoteConn.io);
    let localConn: net.Socket | null = null;
    try {
      if (this.auth !== null) {
        await this.auth.clientHandshake(remoteConn);
      }
      await remoteConn.send(ClientMessage.serialize(ClientMessage.Accept(id)));
      localConn = await connectWithTimeout(this.localHost, this.localPort);
      this.active.add(localConn);
      const parts = remoteConn.intoParts();
      if (parts.readBuf.length > 0) {
        // In most of the cases, this will be empty.
        await new Promise<void>((resolve, reject) => {
          (localConn as net.Socket).write(parts.readBuf, (error) =>
            error ? reject(error) : resolve(),
          );
        });
      }
      await copyBidirectional(localConn, parts.io);
    } finally {
      this.active.delete(remoteConn.io);
      dropStream(remoteConn.io);
      if (localConn !== null) {
        this.active.delete(localConn);
        dropStream(localConn);
      }
    }
  }
}

async function connectWithTimeout(to: string, port: number): Promise<net.Socket> {
  return withContext(
    (async () => {
      const result = await timeout(NETWORK_TIMEOUT, (signal) =>
        tcpConnect(to, port, signal),
      );
      if (!result.ok) {
        throw new Error("deadline has elapsed");
      }
      return result.value;
    })(),
    () => `could not connect to ${to}:${port}`,
  );
}
