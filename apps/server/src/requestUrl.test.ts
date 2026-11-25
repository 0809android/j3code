import { Headers, HttpServerRequest } from "effect/http";
import * as Option from "effect/Option";
import { describe, expect, it } from "@effect/vitest";

import { markRelayRequest } from "./auth/transportSecurity.ts";
import { requestUrl } from "./requestUrl.ts";

const webRequest = (headers: Record<string, string>, path = "/ws?wsTicket=abc") =>
  HttpServerRequest.fromWeb(new Request(`http://127.0.0.1:3773${path}`, { headers }));

describe("requestUrl", () => {
  it("keeps honoring X-Forwarded-Proto and Host for requests that came another way", () => {
    const url = requestUrl(
      webRequest({ host: "host-a.tailnet.ts.net", "x-forwarded-proto": "https" }),
    );
    expect(Option.map(url, (value) => value.href)).toEqual(
      Option.some("https://host-a.tailnet.ts.net/ws?wsTicket=abc"),
    );
    expect(
      Option.map(requestUrl(webRequest({ host: "192.168.1.20:3773" })), (value) => value.href),
    ).toEqual(Option.some("http://192.168.1.20:3773/ws?wsTicket=abc"));
  });

  it("resolves a relayed request against the provisional origin only", () => {
    const expected = Option.some("https://k3host.invalid/ws?wsTicket=abc");
    for (const headers of [
      {},
      { host: "k3host.invalid", "x-forwarded-proto": "https" },
      { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" },
    ]) {
      const request = markRelayRequest(webRequest(headers));
      expect(Option.map(requestUrl(request), (value) => value.href)).toEqual(expected);
    }
  });

  it("does not let a path replace the provisional host", () => {
    const request = markRelayRequest(webRequest({}, "//evil.example/ws"));
    expect(Option.map(requestUrl(request), (value) => value.host)).toEqual(
      Option.some("k3host.invalid"),
    );
  });

  it("keeps the relay origin through a modified request and the Headers helper", () => {
    const request = markRelayRequest(webRequest({}));
    const modified = request.modify({ headers: Headers.fromInput({ host: "evil.example" }) });
    expect(Option.map(requestUrl(modified), (value) => value.origin)).toEqual(
      Option.some("https://k3host.invalid"),
    );
  });
});
