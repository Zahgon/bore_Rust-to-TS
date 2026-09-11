#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { debugError } from "./deps/anyhow.js";
import {
  ClapError,
  commandError,
  ipAddrParser,
  parse,
  stringParser,
  u16Parser,
  type CommandSpec,
} from "./deps/clap.js";
import * as tracing from "./deps/tracing.js";
import { Client } from "./client.js";
import { PortRange, Server } from "./server.js";

/** Mirrors the `#[derive(Parser)]` struct and its `Command` subcommand enum. */
const ARGS: CommandSpec = {
  name: "bore",
  packageName: "bore-cli",
  version: "0.6.0",
  about:
    "A modern, simple TCP tunnel in TypeScript that exposes local ports to a remote " +
    "server, bypassing standard NAT connection firewalls.",
  args: [],
  subcommands: [
    {
      name: "local",
      about: "Starts a local proxy to the remote server",
      args: [
        {
          id: "local_port",
          valueName: "LOCAL_PORT",
          help: "The local port to expose",
          env: "BORE_LOCAL_PORT",
          positional: true,
          parser: u16Parser,
        },
        {
          id: "local_host",
          short: "l",
          long: "local-host",
          valueName: "HOST",
          help: "The local host to expose",
          default: "localhost",
          parser: stringParser,
        },
        {
          id: "to",
          short: "t",
          long: "to",
          valueName: "TO",
          help: "Address of the remote server to expose local ports to",
          env: "BORE_SERVER",
          parser: stringParser,
        },
        {
          id: "port",
          short: "p",
          long: "port",
          valueName: "PORT",
          help: "Optional port on the remote server to select",
          default: "0",
          parser: u16Parser,
        },
        {
          id: "secret",
          short: "s",
          long: "secret",
          valueName: "SECRET",
          help: "Optional secret for authentication",
          env: "BORE_SECRET",
          hideEnvValues: true,
          optional: true,
          parser: stringParser,
        },
      ],
    },
    {
      name: "server",
      about: "Runs the remote proxy server",
      args: [
        {
          id: "min_port",
          long: "min-port",
          valueName: "MIN_PORT",
          help: "Minimum accepted TCP port number",
          env: "BORE_MIN_PORT",
          default: "1024",
          parser: u16Parser,
        },
        {
          id: "max_port",
          long: "max-port",
          valueName: "MAX_PORT",
          help: "Maximum accepted TCP port number",
          env: "BORE_MAX_PORT",
          default: "65535",
          parser: u16Parser,
        },
        {
          id: "secret",
          short: "s",
          long: "secret",
          valueName: "SECRET",
          help: "Optional secret for authentication",
          env: "BORE_SECRET",
          hideEnvValues: true,
          optional: true,
          parser: stringParser,
        },
        {
          id: "bind_addr",
          long: "bind-addr",
          valueName: "BIND_ADDR",
          help: "IP address to bind to, clients must reach this",
          default: "0.0.0.0",
          parser: ipAddrParser,
        },
        {
          id: "bind_tunnels",
          long: "bind-tunnels",
          valueName: "BIND_TUNNELS",
          help: "IP address where tunnels will listen on, defaults to --bind-addr",
          optional: true,
          parser: ipAddrParser,
        },
      ],
    },
  ],
};

export async function run(
  command: string,
  values: Record<string, unknown>,
): Promise<void> {
  switch (command) {
    case "local": {
      const client = await Client.new(
        values["local_host"] as string,
        values["local_port"] as number,
        values["to"] as string,
        values["port"] as number,
        (values["secret"] as string | undefined) ?? null,
      );
      await client.listen();
      return;
    }
    case "server": {
      const minPort = values["min_port"] as number;
      const maxPort = values["max_port"] as number;
      const bindAddr = values["bind_addr"] as string;
      const bindTunnels = values["bind_tunnels"] as string | undefined;

      const portRange = new PortRange(minPort, maxPort);
      if (portRange.isEmpty()) {
        commandError(ARGS, "port range is empty").exit();
      }
      const server = new Server(
        portRange,
        (values["secret"] as string | undefined) ?? null,
      );
      server.setBindAddr(bindAddr);
      server.setBindTunnels(bindTunnels ?? bindAddr);
      await server.listen();
      return;
    }
    default:
      throw new Error(`unhandled command: ${command}`);
  }
}

export async function main(): Promise<void> {
  tracing.init();
  let matches;
  try {
    matches = parse(ARGS, process.argv.slice(2));
  } catch (error) {
    if (error instanceof ClapError) error.exit();
    throw error;
  }
  try {
    await run(matches.command, matches.values);
  } catch (error) {
    if (error instanceof ClapError) error.exit();
    // `fn main() -> Result<()>` prints the error's `Debug` form and exits 1.
    process.stderr.write(`Error: ${debugError(error)}\n`);
    process.exit(1);
  }
}

// Rust's `main.rs` is a separate binary crate: importing the library never runs
// `main`. A bare `void main()` here would execute the CLI on any import, so the
// invocation is guarded to the case where this file *is* the program, which
// restores that separation and lets the entry point be exercised in-process.
// `run` and `main` are exported for the same reason: Rust can unit-test private
// items from inside the crate, and TypeScript has no equivalent.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
