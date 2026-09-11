/**
 * A modern, simple TCP tunnel in TypeScript that exposes local ports to a
 * remote server, bypassing standard NAT connection firewalls.
 *
 * This is the library entry point. If you're looking for usage information
 * about the binary, see the command below.
 *
 * ```shell
 * $ bore help
 * ```
 *
 * There are two components to the package, offering implementations of the
 * server network daemon and client local forwarding proxy. Both are public
 * members and can be run programmatically.
 */

export * as auth from "./auth.js";
export * as client from "./client.js";
export * as server from "./server.js";
export * as shared from "./shared.js";

export { Authenticator } from "./auth.js";
export { Client } from "./client.js";
export { PortRange, Server } from "./server.js";
export {
  ClientMessage,
  CONTROL_PORT,
  Delimited,
  MAX_FRAME_LENGTH,
  NETWORK_TIMEOUT,
  ServerMessage,
} from "./shared.js";
export type { FramedParts } from "./shared.js";
