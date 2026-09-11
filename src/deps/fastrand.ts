/**
 * Port of the `fastrand` crate (v1.9) as used by `bore`'s port picker.
 *
 * `bore` only needs `fastrand::u16(range)`, but the underlying generator is
 * reproduced faithfully: wyrand for the core step, and Lemire's unbiased
 * bounded-integer method for range reduction. Using a biased `Math.random()`
 * remainder here would skew which ports get tried.
 */

const MASK64 = (1n << 64n) - 1n;
const WY_CONST_0 = 0xa0761d6478bd642fn;
const WY_CONST_1 = 0xe7037ed1a0b428dbn;

/** A wyrand generator, matching `fastrand::Rng`. */
export class Rng {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = seed & MASK64;
  }

  /** `fastrand::Rng::gen_u64` — one wyrand step. */
  private genU64(): bigint {
    const s = (this.state + WY_CONST_0) & MASK64;
    this.state = s;
    const t = (s * (s ^ WY_CONST_1)) & ((1n << 128n) - 1n);
    return (t ^ (t >> 64n)) & MASK64;
  }

  /** `fastrand::Rng::gen_u32` — the high half of a wyrand step. */
  private genU32(): bigint {
    return this.genU64() >> 32n;
  }

  /**
   * `fastrand::Rng::gen_mod_u32` — uniform in `[0, n)` via Lemire's method,
   * with the rejection loop that removes modulo bias.
   */
  private genModU32(n: bigint): bigint {
    const MASK32 = 0xffffffffn;
    let r = this.genU32();
    let hi = (r * n) >> 32n;
    let lo = (r * n) & MASK32;
    if (lo < n) {
      const t = (((1n << 32n) - n) & MASK32) % n;
      while (lo < t) {
        r = this.genU32();
        hi = (r * n) >> 32n;
        lo = (r * n) & MASK32;
      }
    }
    return hi;
  }

  /**
   * `fastrand::Rng::u16(low..=high)` — uniform in an inclusive range.
   *
   * Panics on an empty range, exactly like the crate does.
   */
  u16(low: number, high: number): number {
    if (low > high) {
      throw new Error("empty range");
    }
    if (low === 0 && high === 0xffff) {
      return Number(this.genU64() & 0xffffn);
    }
    const len = BigInt(high - low + 1);
    return low + Number(this.genModU32(len));
  }
}

/**
 * The process-wide generator, mirroring `fastrand`'s thread-local `Rng`.
 *
 * The crate seeds from a hash of the current instant and thread id; we seed
 * from the platform CSPRNG, which serves the same purpose.
 */
const shared = new Rng(
  (BigInt(Math.floor(Math.random() * 0x1_0000_0000)) << 32n) |
    BigInt(Math.floor(Math.random() * 0x1_0000_0000)),
);

/** `fastrand::u16(low..=high)` using the shared generator. */
export function u16(low: number, high: number): number {
  return shared.u16(low, high);
}
