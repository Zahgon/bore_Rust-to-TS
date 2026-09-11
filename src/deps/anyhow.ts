/**
 * Port of the pieces of the `anyhow` crate that `bore` relies on.
 *
 * `anyhow::Error` is a boxed error with an attached *context chain*. The two
 * behaviours that are observable in `bore` and therefore reproduced here are:
 *
 * 1. `Display` (i.e. `err.to_string()`) renders **only the outermost context**,
 *    not the whole chain. `bore` puts that string on the wire in
 *    `ServerMessage::Error`, so getting it wrong changes the protocol.
 * 2. `Debug` (what `fn main() -> Result<()>` prints on error) renders the
 *    outermost context, then a `Caused by:` section listing the sources.
 */

/** Equivalent of `anyhow::Error`: a message plus an optional source. */
export class AnyhowError extends Error {
  override readonly name = "Error";

  constructor(message: string, cause?: unknown) {
    // `cause` is only attached when there genuinely is a source error, so that
    // `chain()` matches Rust's `Error::chain()` length exactly.
    super(message, cause === undefined ? undefined : { cause });
  }
}

/** `anyhow::bail!(msg)` — return early with an error. */
export function bail(message: string): never {
  throw new AnyhowError(message);
}

/** `anyhow::ensure!(cond, msg)` — bail unless the condition holds. */
export function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new AnyhowError(message);
  }
}

/**
 * `anyhow::Context::context` — wrap an error with an additional message.
 *
 * The original error is preserved as the `cause`, exactly like Rust keeps the
 * previous error as the new error's source.
 */
export function context(error: unknown, message: string): AnyhowError {
  return new AnyhowError(message, error);
}

/** `result.context(msg)?` for an awaited promise. */
export async function withContext<T>(
  promise: Promise<T>,
  message: string | (() => string),
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw context(error, typeof message === "function" ? message() : message);
  }
}

/**
 * `Display` for an error, i.e. Rust's `err.to_string()` / `{}` / `%err`.
 *
 * Only the outermost message, never the chain.
 */
export function displayError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** `anyhow::Error::chain()` — the error and each of its transitive sources. */
export function chain(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    messages.push(displayError(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages;
}

/**
 * `Debug` for an error — the format `fn main() -> Result<()>` prints when it
 * returns `Err`, minus the backtrace.
 */
export function debugError(error: unknown): string {
  const messages = chain(error);
  const head = messages[0] ?? "";
  if (messages.length <= 1) {
    return head;
  }
  const causes = messages.slice(1).map((m) => `    ${m}`);
  return `${head}\n\nCaused by:\n${causes.join("\n")}`;
}

/**
 * `debug_assert!` — active in debug builds only.
 *
 * Rust disables these in `--release`; we key off `NODE_ENV=production` as the
 * closest equivalent so the assertion still fires during development and tests.
 */
export function debugAssert(condition: boolean, message: string): void {
  if (process.env["NODE_ENV"] !== "production" && !condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}
