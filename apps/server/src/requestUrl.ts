import * as Option from "effect/Option";
import { Headers, HttpServerRequest } from "effect/http";

import { isRelayRequest, RELAY_PROVISIONAL_HOST } from "./auth/transportSecurity.ts";

/**
 * `HttpServerRequest.toURL` that honors `X-Forwarded-Proto: https`, which Effect 4.1 stopped
 * reading. A relayed request always resolves against `https://k3host.invalid`, never against
 * the `Host` or `X-Forwarded-*` headers a device sent.
 */
export const requestUrl = (request: HttpServerRequest.HttpServerRequest): Option.Option<URL> =>
  HttpServerRequest.toURL(
    isRelayRequest(request)
      ? request.modify({
          headers: Headers.set(request.headers, "host", RELAY_PROVISIONAL_HOST),
          protocol: "https",
        })
      : request.headers["x-forwarded-proto"] === "https" && request.protocol !== "https"
        ? request.modify({ protocol: "https" })
        : request,
  );
