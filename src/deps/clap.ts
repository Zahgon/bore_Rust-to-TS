/**
 * Port of the `clap` v4 derive surface that `bore` uses.
 *
 * The rendered help, the `[env: ...]` / `[default: ...]` annotations, the error
 * wording and the exit codes are all reproduced to match the Rust binary's
 * output, which was captured from the compiled `bore` for reference.
 */

/** How a raw string becomes a typed value, mirroring `FromStr`. */
export interface ValueParser<T> {
  readonly name: string;
  parse(raw: string): T;
}

/** `u16::from_str`, including Rust's exact error strings. */
export const u16Parser: ValueParser<number> = {
  name: "u16",
  parse(raw: string): number {
    if (raw.length === 0) {
      throw new Error("cannot parse integer from empty string");
    }
    if (!/^\+?[0-9]+$/.test(raw)) {
      throw new Error("invalid digit found in string");
    }
    const value = Number(raw);
    if (value > 65_535) {
      // clap validates the range itself, so this is clap's wording rather than
      // the `number too large to fit in target type` that `u16::from_str` gives.
      throw new Error(`${raw} is not in 0..=65535`);
    }
    return value;
  },
};

/** `String::from_str`. */
export const stringParser: ValueParser<string> = {
  name: "String",
  parse: (raw: string): string => raw,
};

/** `IpAddr::from_str`. */
export const ipAddrParser: ValueParser<string> = {
  name: "IpAddr",
  parse(raw: string): string {
    const v4 =
      /^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
    if (v4.test(raw)) return raw;
    // A pragmatic IPv6 check: hex groups and at most one "::" elision.
    if (/^[0-9a-fA-F:]+$/.test(raw) && raw.includes(":")) {
      const elisions = raw.split("::").length - 1;
      const groups = raw.split(":").filter((g) => g !== "");
      if (elisions <= 1 && groups.length <= 8 && groups.every((g) => g.length <= 4)) {
        return raw;
      }
    }
    throw new Error("invalid IP address syntax");
  },
};

/** A single option or positional argument. */
export interface Arg {
  /** Field name used to look the parsed value up. */
  id: string;
  /** Long flag, without the leading dashes. Absent for positionals. */
  long?: string;
  /** Short flag, without the leading dash. */
  short?: string;
  /** Placeholder shown in help, e.g. `TO` in `--to <TO>`. */
  valueName: string;
  /** Doc comment shown in help. */
  help: string;
  /** Environment variable consulted when the flag is absent. */
  env?: string;
  /** `hide_env_values` — show `[env: NAME]` rather than `[env: NAME=value]`. */
  hideEnvValues?: boolean;
  /** Rendered as `[default: ...]`, and used when nothing else supplies a value. */
  default?: string;
  /** Positional arguments are matched by position rather than by flag. */
  positional?: boolean;
  /** Optional arguments produce `undefined` instead of erroring when absent. */
  optional?: boolean;
  /** Value parser. */
  parser: ValueParser<unknown>;
}

/** A subcommand, or the top-level command. */
export interface CommandSpec {
  name: string;
  about: string;
  args: Arg[];
  subcommands?: CommandSpec[];
  version?: string;
  /**
   * Name clap derives from the package, used by `--version` and
   * `Command::error()`. The `[[bin]]` name is what appears in usage lines.
   */
  packageName?: string;
}

/** A `clap` error, carrying the process exit code it should produce. */
export class ClapError extends Error {
  constructor(
    override readonly message: string,
    readonly exitCode: number,
    readonly stream: "stdout" | "stderr",
  ) {
    super(message);
  }

  /** `Error::exit()` — print to the right stream and terminate. */
  exit(): never {
    const text = this.stream === "stdout" ? this.message : this.message;
    process[this.stream].write(`${text}\n`);
    process.exit(this.exitCode);
  }
}

function usageFor(
  root: CommandSpec,
  command: CommandSpec | null,
  context: "help" | "error" = "help",
): string {
  if (command === null) {
    return `Usage: ${root.name} <COMMAND>`;
  }
  const required = command.args.filter(
    (a) => !a.positional && !a.optional && !a.default,
  );
  const positionals = command.args.filter((a) => a.positional);
  const pieces = [`${root.name} ${command.name}`];
  // clap only advertises `[OPTIONS]` in help; error usage lists just what is
  // required.
  if (context === "help" && command.args.some((a) => !a.positional)) {
    pieces.push("[OPTIONS]");
  }
  for (const arg of required) pieces.push(`--${arg.long} <${arg.valueName}>`);
  for (const arg of positionals) pieces.push(`<${arg.valueName}>`);
  return `Usage: ${pieces.join(" ")}`;
}

function flagLabel(arg: Arg): string {
  if (arg.positional) return `<${arg.valueName}>`;
  const short = arg.short ? `-${arg.short}, ` : "    ";
  return `${short}--${arg.long} <${arg.valueName}>`;
}

function annotations(arg: Arg): string {
  const parts: string[] = [];
  if (arg.env !== undefined) {
    if (arg.hideEnvValues) {
      parts.push(`[env: ${arg.env}]`);
    } else {
      parts.push(`[env: ${arg.env}=${process.env[arg.env] ?? ""}]`);
    }
  }
  if (arg.default !== undefined) parts.push(`[default: ${arg.default}]`);
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

function renderRows(rows: Array<[string, string]>): string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, help]) => `${label.padEnd(width)}  ${help}`.trimEnd());
}

/** Render `--help` for the top-level command. */
export function renderRootHelp(root: CommandSpec): string {
  const lines = [root.about, "", usageFor(root, null), "", "Commands:"];
  const commandRows: Array<[string, string]> = [
    ...(root.subcommands ?? []).map((sub): [string, string] => [
      `  ${sub.name}`,
      sub.about,
    ]),
    ["  help", "Print this message or the help of the given subcommand(s)"],
  ];
  lines.push(...renderRows(commandRows), "", "Options:");
  lines.push(
    ...renderRows([
      ["  -h, --help", "Print help"],
      ["  -V, --version", "Print version"],
    ]),
  );
  return lines.join("\n");
}

/** Render `--help` for a subcommand. */
export function renderCommandHelp(root: CommandSpec, command: CommandSpec): string {
  const lines = [command.about, "", usageFor(root, command), ""];
  const positionals = command.args.filter((a) => a.positional);
  if (positionals.length > 0) {
    lines.push("Arguments:");
    lines.push(
      ...renderRows(
        positionals.map((arg): [string, string] => [
          `  ${flagLabel(arg)}`,
          `${arg.help}${annotations(arg)}`,
        ]),
      ),
    );
    lines.push("");
  }
  lines.push("Options:");
  const optionRows: Array<[string, string]> = command.args
    .filter((a) => !a.positional)
    .map((arg): [string, string] => [
      `  ${flagLabel(arg)}`,
      `${arg.help}${annotations(arg)}`,
    ]);
  optionRows.push(["  -h, --help", "Print help"]);
  lines.push(...renderRows(optionRows));
  return lines.join("\n");
}

function fail(root: CommandSpec, command: CommandSpec | null, message: string): never {
  const usage = usageFor(root, command, "error");
  throw new ClapError(
    `error: ${message}\n\n${usage}\n\nFor more information, try '--help'.`,
    2,
    "stderr",
  );
}

/**
 * `error: a value is required for '<flag>' but none was supplied`.
 *
 * clap prints no usage line for this one.
 */
function failMissingValue(arg: Arg): never {
  throw new ClapError(
    `error: a value is required for '--${arg.long} <${arg.valueName}>' but none was ` +
      `supplied\n\nFor more information, try '--help'.`,
    2,
    "stderr",
  );
}

/**
 * The "all arguments" usage clap switches to when a stray long flag appears on a
 * command that has positionals and whose required options are already satisfied.
 */
function alternateUsage(root: CommandSpec, command: CommandSpec): string {
  const parts = command.args.map((arg) =>
    arg.positional ? arg.valueName : `--${arg.long} <${arg.valueName}>`,
  );
  return `Usage: ${root.name} ${command.name} <${parts.join("|")}>`;
}

/**
 * `error: unexpected argument '<token>' found`.
 *
 * Two details are reproduced from clap: the `tip:` line only appears when the
 * token looks like a flag *and* the command has a positional that `--` could
 * route it to; and a stray long flag switches the usage line to the
 * "all arguments" form once every required option has already been supplied.
 */
function failUnexpected(
  root: CommandSpec,
  command: CommandSpec,
  token: string,
  supplied: Record<string, string>,
): never {
  const hasPositional = command.args.some((a) => a.positional);
  const isFlag = token.startsWith("-");
  const isLong = token.startsWith("--");
  const requiredSatisfied = command.args
    .filter((a) => !a.positional && !a.optional && a.default === undefined)
    .every((a) => supplied[a.id] !== undefined);

  const lines = [`error: unexpected argument '${token}' found`, ""];
  if (isFlag && hasPositional) {
    lines.push(`  tip: to pass '${token}' as a value, use '-- ${token}'`, "");
  }
  const usage =
    isLong && hasPositional && requiredSatisfied
      ? alternateUsage(root, command)
      : usageFor(root, command, "help");
  lines.push(usage, "", "For more information, try '--help'.");
  throw new ClapError(lines.join("\n"), 2, "stderr");
}

/** A parsed command invocation. */
export interface Matches {
  command: string;
  values: Record<string, unknown>;
}

/** `Parser::parse()` — parse argv, honouring env vars, help and version. */
export function parse(root: CommandSpec, argv: string[]): Matches {
  if (argv.length === 0) {
    throw new ClapError(renderRootHelp(root), 2, "stderr");
  }

  const head = argv[0] as string;
  if (head === "-h" || head === "--help" || head === "help") {
    const target = argv[1];
    if (target !== undefined) {
      const sub = (root.subcommands ?? []).find((s) => s.name === target);
      if (sub) throw new ClapError(renderCommandHelp(root, sub), 0, "stdout");
    }
    throw new ClapError(renderRootHelp(root), 0, "stdout");
  }
  if (head === "-V" || head === "--version") {
    const displayName = root.packageName ?? root.name;
    throw new ClapError(`${displayName} ${root.version ?? ""}`.trim(), 0, "stdout");
  }

  const command = (root.subcommands ?? []).find((s) => s.name === head);
  if (command === undefined) {
    fail(root, null, `unrecognized subcommand '${head}'`);
  }

  const rest = argv.slice(1);
  const raw: Record<string, string> = {};
  const positionals = command.args.filter((a) => a.positional);
  let positionalIndex = 0;
  let onlyPositional = false;

  const byLong = new Map(
    command.args.filter((a) => a.long).map((a) => [a.long as string, a]),
  );
  const byShort = new Map(
    command.args.filter((a) => a.short).map((a) => [a.short as string, a]),
  );

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;

    if (!onlyPositional && token === "--") {
      onlyPositional = true;
      continue;
    }
    if (!onlyPositional && (token === "-h" || token === "--help")) {
      throw new ClapError(renderCommandHelp(root, command), 0, "stdout");
    }

    if (!onlyPositional && token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const arg = byLong.get(name);
      if (arg === undefined) {
        failUnexpected(root, command, token, raw);
      }
      if (eq !== -1) {
        raw[arg.id] = token.slice(eq + 1);
      } else {
        const next = rest[i + 1];
        if (next === undefined) {
          failMissingValue(arg);
        }
        raw[arg.id] = next;
        i += 1;
      }
      continue;
    }

    if (!onlyPositional && token.startsWith("-") && token.length > 1) {
      const name = token[1] as string;
      const arg = byShort.get(name);
      if (arg === undefined) {
        failUnexpected(root, command, token, raw);
      }
      if (token.length > 2) {
        raw[arg.id] = token.slice(2);
      } else {
        const next = rest[i + 1];
        if (next === undefined) {
          failMissingValue(arg);
        }
        raw[arg.id] = next;
        i += 1;
      }
      continue;
    }

    const target = positionals[positionalIndex];
    if (target === undefined) {
      failUnexpected(root, command, token, raw);
    }
    raw[target.id] = token;
    positionalIndex += 1;
  }

  const values: Record<string, unknown> = {};
  // clap reports missing options ahead of missing positionals.
  const missingOptions: string[] = [];
  const missingPositionals: string[] = [];

  for (const arg of command.args) {
    let source = raw[arg.id];
    if (source === undefined && arg.env !== undefined) {
      const fromEnv = process.env[arg.env];
      if (fromEnv !== undefined && fromEnv !== "") source = fromEnv;
    }
    if (source === undefined && arg.default !== undefined) {
      source = arg.default;
    }
    if (source === undefined) {
      if (arg.optional) {
        values[arg.id] = undefined;
      } else if (arg.positional) {
        missingPositionals.push(`<${arg.valueName}>`);
      } else {
        missingOptions.push(`--${arg.long} <${arg.valueName}>`);
      }
      continue;
    }
    try {
      values[arg.id] = arg.parser.parse(source);
    } catch (error) {
      const label = arg.positional
        ? `<${arg.valueName}>`
        : `--${arg.long} <${arg.valueName}>`;
      throw new ClapError(
        `error: invalid value '${source}' for '${label}': ${(error as Error).message}\n\n` +
          `For more information, try '--help'.`,
        2,
        "stderr",
      );
    }
  }

  const missing = [...missingOptions, ...missingPositionals];
  if (missing.length > 0) {
    fail(
      root,
      command,
      `the following required arguments were not provided:\n${missing
        .map((m) => `  ${m}`)
        .join("\n")}`,
    );
  }

  return { command: command.name, values };
}

/** `Command::error(kind, message).exit()`. */
export function commandError(root: CommandSpec, message: string): ClapError {
  // `Args::command()` is derived from the package, so its usage line uses the
  // package name rather than the `[[bin]]` name.
  const derived = { ...root, name: root.packageName ?? root.name };
  return new ClapError(
    `error: ${message}\n\n${usageFor(derived, null)}\n\nFor more information, try '--help'.`,
    2,
    "stderr",
  );
}
