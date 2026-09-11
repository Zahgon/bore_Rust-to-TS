import { expect, test } from "vitest";

import { Authenticator } from "../src/auth.js";
import { duplex } from "../src/deps/tokio.js";
import * as uuid from "../src/deps/uuid.js";
import { Delimited } from "../src/shared.js";

test("auth_handshake", async () => {
  const auth = new Authenticator("some secret string");

  const [clientIo, serverIo] = duplex(8); // Ensure correctness with limited capacity.
  const client = new Delimited(clientIo);
  const server = new Delimited(serverIo);

  // `tokio::try_join!` drives both halves concurrently and fails if either does.
  await Promise.all([auth.clientHandshake(client), auth.serverHandshake(server)]);
});

test("auth_handshake_fail", async () => {
  const auth = new Authenticator("client secret");
  const auth2 = new Authenticator("different server secret");

  const [clientIo, serverIo] = duplex(8); // Ensure correctness with limited capacity.
  const client = new Delimited(clientIo);
  const server = new Delimited(serverIo);

  const result = await Promise.allSettled([
    auth.clientHandshake(client),
    auth2.serverHandshake(server),
  ]);
  expect(result.some((outcome) => outcome.status === "rejected")).toBe(true);
});

// `src/auth.rs`'s doctest on `Authenticator::validate`, which `cargo test` runs
// as part of the suite.
test("auth_validate_doctest", () => {
  const auth = new Authenticator("secret");
  const challenge = uuid.newV4();

  expect(auth.validate(challenge, auth.answer(challenge))).toBe(true);
  expect(auth.validate(challenge, "wrong answer")).toBe(false);
});
