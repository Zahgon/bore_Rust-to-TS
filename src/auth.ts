/** Auth implementation for bore client and server. */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";

import { bail, ensure } from "./deps/anyhow.js";
import * as uuid from "./deps/uuid.js";
import { ClientMessage, Delimited, ServerMessage } from "./shared.js";

/** Wrapper around a MAC used for authenticating clients that have a secret. */
export class Authenticator {
  /**
   * The HMAC key: `Sha256::new().chain_update(secret).finalize()`.
   *
   * Note the secret is hashed *before* being used as the key, matching
   * `Hmac::new_from_slice(&hashed_secret)` in the Rust implementation.
   */
  private readonly key: Buffer;

  /** Generate an authenticator from a secret. */
  constructor(secret: string) {
    this.key = createHash("sha256").update(secret, "utf8").digest();
  }

  /** Generate a reply message for a challenge. */
  answer(challenge: string): string {
    return createHmac("sha256", this.key).update(uuid.asBytes(challenge)).digest("hex");
  }

  /**
   * Validate a reply to a challenge.
   *
   * ```ts
   * import { Authenticator } from "bore-cli/auth";
   * import * as uuid from "bore-cli/deps/uuid.js";
   *
   * const auth = new Authenticator("secret");
   * const challenge = uuid.newV4();
   *
   * assert(auth.validate(challenge, auth.answer(challenge)));
   * assert(!auth.validate(challenge, "wrong answer"));
   * ```
   */
  validate(challenge: string, tag: string): boolean {
    // `hex::decode` rejects odd lengths and non-hex characters; `Buffer.from`
    // would silently truncate instead, so the input is screened first.
    if (tag.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(tag)) {
      return false;
    }
    const decoded = Buffer.from(tag, "hex");
    const expected = createHmac("sha256", this.key)
      .update(uuid.asBytes(challenge))
      .digest();
    // `Mac::verify_slice` is length-checked and constant-time.
    if (decoded.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(decoded, expected);
  }

  /** As the server, send a challenge to the client and validate their response. */
  async serverHandshake<T extends Duplex>(stream: Delimited<T>): Promise<void> {
    const challenge = uuid.newV4();
    await stream.send(ServerMessage.serialize(ServerMessage.Challenge(challenge)));
    const message = await stream.recvTimeout(ClientMessage.deserialize);
    if (message !== null && message.kind === "Authenticate") {
      ensure(this.validate(challenge, message.value), "invalid secret");
      return;
    }
    bail("server requires secret, but no secret was provided");
  }

  /** As the client, answer a challenge to attempt to authenticate with the server. */
  async clientHandshake<T extends Duplex>(stream: Delimited<T>): Promise<void> {
    const message = await stream.recvTimeout(ServerMessage.deserialize);
    if (message === null || message.kind !== "Challenge") {
      bail("expected authentication challenge, but no secret was required");
    }
    const tag = this.answer(message.value);
    await stream.send(ClientMessage.serialize(ClientMessage.Authenticate(tag)));
  }
}
