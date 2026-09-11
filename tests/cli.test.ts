/**
 * CLI parity tests.
 *
 * The golden files in `tests/golden/` were produced by running the **compiled
 * Rust binary** and capturing its output verbatim, so these assert against the
 * original implementation rather than against this port's own behaviour. The
 * only edit applied is the one intentional wording deviation, "tunnel in Rust"
 * → "tunnel in TypeScript".
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

import {
  ClapError,
  commandError,
  ipAddrParser,
  parse,
  renderCommandHelp,
  renderRootHelp,
  stringParser,
  u16Parser,
  type CommandSpec,
} from "../src/deps/clap.js";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "golden");
const golden = (name: string): string =>
  readFileSync(join(GOLDEN, `${name}.txt`), "utf8").trimEnd();

/** The same spec `src/main.ts` declares, kept in sync with it. */
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

const sub = (name: string): CommandSpec =>
  (ARGS.subcommands ?? []).find((s) => s.name === name) as CommandSpec;

/** Run `parse` and return the error text a real invocation would print. */
function parseError(argv: string[]): { text: string; exitCode: number } {
  try {
    parse(ARGS, argv);
  } catch (error) {
    if (error instanceof ClapError) {
      return { text: error.message, exitCode: error.exitCode };
    }
    throw error;
  }
  throw new Error(`expected ${argv.join(" ")} to fail`);
}

beforeEach(() => {
  // The `[env: X=value]` annotations read the live environment.
  for (const key of [
    "BORE_SECRET",
    "BORE_SERVER",
    "BORE_MIN_PORT",
    "BORE_MAX_PORT",
    "BORE_LOCAL_PORT",
  ]) {
    delete process.env[key];
  }
});

describe("help output matches the Rust binary", () => {
  test("root help", () => {
    expect(renderRootHelp(ARGS)).toBe(golden("root_help"));
  });
  test("local help", () => {
    expect(renderCommandHelp(ARGS, sub("local"))).toBe(golden("local_help"));
  });
  test("server help", () => {
    expect(renderCommandHelp(ARGS, sub("server"))).toBe(golden("server_help"));
  });
  test("--version uses the package name, not the bin name", () => {
    expect(parseError(["--version"]).text).toBe(golden("version"));
    expect(parseError(["--version"]).exitCode).toBe(0);
  });
});

describe("error output matches the Rust binary", () => {
  const cases: Array<[string, string[]]> = [
    ["err_missing_required", ["local"]],
    ["err_missing_to", ["local", "8000"]],
    ["err_unknown_subcommand", ["badcmd"]],
    ["err_invalid_u16", ["local", "abc", "--to", "x"]],
    ["err_u16_range", ["local", "99999", "--to", "x"]],
    ["err_invalid_ip", ["server", "--bind-addr", "notanip"]],
    ["err_missing_value", ["local", "--to"]],
    ["err_unexpected_long_satisfied", ["local", "--to", "x", "--zzz"]],
    ["err_unexpected_short", ["local", "8000", "--to", "x", "-Z"]],
    ["err_unexpected_no_positional", ["server", "--bogus"]],
  ];
  test.each(cases)("%s", (name, argv) => {
    const { text, exitCode } = parseError(argv);
    expect(text).toBe(golden(name));
    expect(exitCode).toBe(2);
  });

  test("empty port range error (Command::error) uses the derived package name", () => {
    const error = commandError(ARGS, "port range is empty");
    expect(error.message).toBe(golden("err_port_range_empty"));
    expect(error.exitCode).toBe(2);
  });
});

describe("value parsing", () => {
  test("u16 accepts the full range", () => {
    expect(u16Parser.parse("0")).toBe(0);
    expect(u16Parser.parse("65535")).toBe(65535);
  });
  test("u16 rejects out-of-range with clap's wording", () => {
    expect(() => u16Parser.parse("65536")).toThrow("65536 is not in 0..=65535");
  });
  test("u16 rejects non-numeric and empty input", () => {
    expect(() => u16Parser.parse("abc")).toThrow("invalid digit found in string");
    expect(() => u16Parser.parse("")).toThrow("cannot parse integer from empty string");
    expect(() => u16Parser.parse("12.5")).toThrow("invalid digit found in string");
  });
  test("IpAddr accepts v4 and v6, rejects malformed", () => {
    expect(ipAddrParser.parse("0.0.0.0")).toBe("0.0.0.0");
    expect(ipAddrParser.parse("255.255.255.255")).toBe("255.255.255.255");
    expect(ipAddrParser.parse("::1")).toBe("::1");
    expect(() => ipAddrParser.parse("1.2.3.4.5")).toThrow("invalid IP address syntax");
    expect(() => ipAddrParser.parse("256.0.0.1")).toThrow("invalid IP address syntax");
    expect(() => ipAddrParser.parse("notanip")).toThrow("invalid IP address syntax");
  });
});

describe("argument binding", () => {
  test("defaults are applied", () => {
    const { values } = parse(ARGS, ["local", "8000", "--to", "example.com"]);
    expect(values["local_host"]).toBe("localhost");
    expect(values["port"]).toBe(0);
    expect(values["secret"]).toBeUndefined();
    expect(values["local_port"]).toBe(8000);
    expect(values["to"]).toBe("example.com");
  });

  test("long, short, and =-joined forms are equivalent", () => {
    const expected = {
      local_port: 1,
      to: "h",
      port: 42,
      local_host: "lh",
      secret: "s",
    };
    for (const argv of [
      [
        "local",
        "1",
        "--to",
        "h",
        "--port",
        "42",
        "--local-host",
        "lh",
        "--secret",
        "s",
      ],
      ["local", "1", "-t", "h", "-p", "42", "-l", "lh", "-s", "s"],
      ["local", "1", "--to=h", "--port=42", "--local-host=lh", "--secret=s"],
      ["local", "1", "-th", "-p42", "-llh", "-ss"],
    ]) {
      const { values } = parse(ARGS, argv);
      expect(values).toMatchObject(expected);
    }
  });

  test("environment variables satisfy required arguments", () => {
    process.env["BORE_LOCAL_PORT"] = "7000";
    process.env["BORE_SERVER"] = "env.example";
    process.env["BORE_SECRET"] = "envsecret";
    const { values } = parse(ARGS, ["local"]);
    expect(values["local_port"]).toBe(7000);
    expect(values["to"]).toBe("env.example");
    expect(values["secret"]).toBe("envsecret");
  });

  test("explicit flags win over environment variables", () => {
    process.env["BORE_SERVER"] = "env.example";
    const { values } = parse(ARGS, ["local", "1", "--to", "flag.example"]);
    expect(values["to"]).toBe("flag.example");
  });

  test("help annotations show env values, except where hidden", () => {
    process.env["BORE_MIN_PORT"] = "5000";
    process.env["BORE_SECRET"] = "hunter2";
    const help = renderCommandHelp(ARGS, sub("server"));
    expect(help).toContain("[env: BORE_MIN_PORT=5000]");
    // `hide_env_values` must never leak the secret into help output.
    expect(help).toContain("[env: BORE_SECRET]");
    expect(help).not.toContain("hunter2");
  });

  test("`--` routes a flag-like token to the positional", () => {
    const { values } = parse(ARGS, ["local", "--to", "h", "--", "8000"]);
    expect(values["local_port"]).toBe(8000);
  });

  test("server defaults span the whole port range", () => {
    const { values } = parse(ARGS, ["server"]);
    expect(values["min_port"]).toBe(1024);
    expect(values["max_port"]).toBe(65535);
    expect(values["bind_addr"]).toBe("0.0.0.0");
    expect(values["bind_tunnels"]).toBeUndefined();
  });

  test("help requests exit 0 and print to stdout", () => {
    for (const argv of [
      ["--help"],
      ["-h"],
      ["help"],
      ["local", "--help"],
      ["help", "server"],
    ]) {
      const error = parseError(argv);
      expect(error.exitCode).toBe(0);
    }
  });
});
