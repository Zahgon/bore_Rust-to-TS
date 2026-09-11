/**
 * Port of `tracing` + `tracing_subscriber::fmt`, reproducing the exact console
 * output of the Rust binary: RFC 3339 timestamps with microsecond precision, a
 * right-aligned five-column level, span context, the `target`, the message, and
 * then the fields — with the same ANSI styling.
 *
 * `tracing_subscriber::fmt::init()` enables ANSI unconditionally (it does not
 * probe for a TTY) and filters at INFO when `RUST_LOG` is unset; both were
 * confirmed against the compiled Rust binary and are matched here.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** `tracing::Level`, ordered so that a numeric comparison filters correctly. */
export enum Level {
  Trace = 0,
  Debug = 1,
  Info = 2,
  Warn = 3,
  Error = 4,
}

const LEVEL_NAMES: Record<Level, string> = {
  [Level.Trace]: "TRACE",
  [Level.Debug]: "DEBUG",
  [Level.Info]: " INFO",
  [Level.Warn]: " WARN",
  [Level.Error]: "ERROR",
};

// tracing-subscriber's level colours.
const LEVEL_COLORS: Record<Level, string> = {
  [Level.Trace]: "\x1b[35m",
  [Level.Debug]: "\x1b[34m",
  [Level.Info]: "\x1b[32m",
  [Level.Warn]: "\x1b[33m",
  [Level.Error]: "\x1b[31m",
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";

/** Structured key/value pairs attached to an event or span. */
export type Fields = Record<string, string>;

/** A `tracing` span, as produced by `info_span!`. */
export interface Span {
  name: string;
  fields: Fields;
}

const spanStorage = new AsyncLocalStorage<Span[]>();

/** `tracing::info_span!(name, fields...)`. */
export function infoSpan(name: string, fields: Fields = {}): Span {
  return { name, fields };
}

/**
 * `Instrument::instrument(span)` — run an async body inside a span.
 *
 * `AsyncLocalStorage` propagates the span across `await` points, which is the
 * equivalent of tokio attaching the span to a spawned task.
 */
export function instrument<T>(span: Span, body: () => Promise<T>): Promise<T> {
  const parents = spanStorage.getStore() ?? [];
  return spanStorage.run([...parents, span], body);
}

interface Directive {
  target: string | null;
  level: Level;
}

let directives: Directive[] = [{ target: null, level: Level.Info }];
let initialized = false;

function parseLevel(name: string): Level | null {
  switch (name.trim().toLowerCase()) {
    case "trace":
      return Level.Trace;
    case "debug":
      return Level.Debug;
    case "info":
      return Level.Info;
    case "warn":
      return Level.Warn;
    case "error":
      return Level.Error;
    case "off":
      return null;
    default:
      return null;
  }
}

/**
 * `tracing_subscriber::fmt::init()`.
 *
 * Builds the filter from `RUST_LOG`, supporting the `level` and `target=level`
 * directive forms; the most specific matching target prefix wins.
 */
export function init(): void {
  initialized = true;
  const env = process.env["RUST_LOG"];
  if (env === undefined || env.trim() === "") {
    directives = [{ target: null, level: Level.Info }];
    return;
  }
  const parsed: Directive[] = [];
  for (const raw of env.split(",")) {
    const piece = raw.trim();
    if (piece === "") continue;
    const eq = piece.lastIndexOf("=");
    if (eq === -1) {
      const level = parseLevel(piece);
      if (level !== null) parsed.push({ target: null, level });
    } else {
      const level = parseLevel(piece.slice(eq + 1));
      if (level !== null) parsed.push({ target: piece.slice(0, eq).trim(), level });
    }
  }
  directives = parsed.length > 0 ? parsed : [{ target: null, level: Level.Info }];
}

function enabled(target: string, level: Level): boolean {
  if (!initialized) return false;
  let best: Directive | null = null;
  for (const directive of directives) {
    if (directive.target === null) {
      if (best === null || best.target === null) best = directive;
    } else if (
      target === directive.target ||
      target.startsWith(`${directive.target}::`)
    ) {
      if (
        best === null ||
        best.target === null ||
        directive.target.length > best.target.length
      ) {
        best = directive;
      }
    }
  }
  return best !== null && level >= best.level;
}

function timestamp(): string {
  // `Date` only carries millisecond precision, so the microsecond digits come
  // from the high-resolution clock, matching tracing's 6-digit output.
  const now = performance.timeOrigin + performance.now();
  const millis = Math.floor(now);
  const micros = Math.floor((now - millis) * 1000);
  return `${new Date(millis).toISOString().slice(0, -1)}${String(micros).padStart(3, "0")}Z`;
}

function renderFields(fields: Fields): string {
  return Object.entries(fields)
    .map(([key, value]) => `${ITALIC}${key}${RESET}${DIM}=${RESET}${value}`)
    .join(" ");
}

function renderSpans(spans: Span[]): string {
  if (spans.length === 0) return "";
  const rendered = spans.map((span) => {
    const fields = renderFields(span.fields);
    const body = fields === "" ? "" : `${BOLD}{${fields}${BOLD}}${RESET}`;
    return fields === "" ? `${BOLD}${span.name}${RESET}` : `${BOLD}${span.name}${body}`;
  });
  return `${rendered.join(`${DIM}:${RESET}`)}${DIM}:${RESET} `;
}

function event(level: Level, target: string, message: string, fields: Fields): void {
  if (!enabled(target, level)) return;
  const spans = spanStorage.getStore() ?? [];
  const parts = [
    `${DIM}${timestamp()}${RESET}`,
    `${LEVEL_COLORS[level]}${LEVEL_NAMES[level]}${RESET}`,
    `${renderSpans(spans)}${DIM}${target}${RESET}${DIM}:${RESET}`,
    message,
  ];
  const rendered = renderFields(fields);
  const line = rendered === "" ? parts.join(" ") : `${parts.join(" ")} ${rendered}`;
  process.stdout.write(`${line}\n`);
}

/** `tracing::trace!`. */
export function trace(target: string, message: string, fields: Fields = {}): void {
  event(Level.Trace, target, message, fields);
}

/** `tracing::debug!`. */
export function debug(target: string, message: string, fields: Fields = {}): void {
  event(Level.Debug, target, message, fields);
}

/** `tracing::info!`. */
export function info(target: string, message: string, fields: Fields = {}): void {
  event(Level.Info, target, message, fields);
}

/** `tracing::warn!`. */
export function warn(target: string, message: string, fields: Fields = {}): void {
  event(Level.Warn, target, message, fields);
}

/** `tracing::error!`. */
export function error(target: string, message: string, fields: Fields = {}): void {
  event(Level.Error, target, message, fields);
}
