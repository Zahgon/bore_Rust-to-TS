/**
 * Port of `tokio::sync::Mutex`, used by the test suite's `SERIAL_GUARD`.
 *
 * Node is single-threaded, but the tests still need mutual exclusion across
 * concurrently *scheduled* async test bodies, which is exactly what the Rust
 * suite uses the mutex for.
 */

/** A FIFO async mutex. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /**
   * `Mutex::lock().await` — resolves to the guard's release function.
   *
   * Callers should use `try { ... } finally { release(); }`, which is the
   * closest equivalent to Rust dropping the guard at end of scope.
   */
  async lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    return release;
  }
}
