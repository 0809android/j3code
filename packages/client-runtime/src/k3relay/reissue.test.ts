import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ConnectionBlockedError, ConnectionTransientError } from "../connection/model.ts";
import { authorizeWithReissue } from "./reissue.ts";

const refused = new ConnectionBlockedError({
  reason: "authentication",
  detail: "The environment credential is invalid.",
  hop: "server",
});

/** An authorize that fails with each given error in turn, then succeeds. */
const scripted = (failures: ReadonlyArray<ConnectionBlockedError | ConnectionTransientError>) => {
  let calls = 0;
  return {
    calls: () => calls,
    authorize: Effect.suspend(() => {
      const failure = failures[calls];
      calls += 1;
      return failure === undefined ? Effect.succeed("authorized") : Effect.fail(failure);
    }),
  };
};

describe("authorizeWithReissue", () => {
  it.effect("renews a refused session once, then authorizes with the new one", () =>
    Effect.gen(function* () {
      const attempt = scripted([refused]);
      let reissued = 0;
      const result = yield* authorizeWithReissue({
        authorize: attempt.authorize,
        reissue: Effect.sync(() => {
          reissued += 1;
        }),
      });
      expect(result).toBe("authorized");
      expect(reissued).toBe(1);
      expect(attempt.calls()).toBe(2);
    }),
  );

  it.effect("does not loop: a session refused again after renewal fails", () =>
    Effect.gen(function* () {
      const attempt = scripted([refused, refused, refused]);
      let reissued = 0;
      const error = yield* authorizeWithReissue({
        authorize: attempt.authorize,
        reissue: Effect.sync(() => {
          reissued += 1;
        }),
      }).pipe(Effect.flip);
      expect(error).toBe(refused);
      expect(reissued).toBe(1);
    }),
  );

  it.effect("leaves other failures, and a refused renewal, as they were", () =>
    Effect.gen(function* () {
      const offline = new ConnectionTransientError({ reason: "network", detail: "offline" });
      let reissued = 0;
      const transient = yield* authorizeWithReissue({
        authorize: scripted([offline]).authorize,
        reissue: Effect.sync(() => {
          reissued += 1;
        }),
      }).pipe(Effect.flip);
      expect(transient).toBe(offline);
      expect(reissued).toBe(0);
      // The host said no to the device itself (revoked): the original refusal is what shows.
      const denied = yield* authorizeWithReissue({
        authorize: scripted([refused]).authorize,
        reissue: Effect.fail("refused"),
      }).pipe(Effect.flip);
      expect(denied).toBe(refused);
    }),
  );
});
