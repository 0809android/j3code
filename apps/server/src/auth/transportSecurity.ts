import type { RemoteTransportPolicy } from "@t3tools/contracts";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Option from "effect/Option";

import {
  isLocalLoopbackHost,
  isSharedAddressSpaceHost,
  isTailnetHost,
} from "@t3tools/shared/hostClassification";

/**
 * How a request reached this server. SSH port-forwards present as loopback
 * traffic, so they count as `loopback`; the client labels them separately.
 * `k3relay` is a request the in-process `RelayConnector` built from a device's
 * end-to-end-encrypted relay channel; see {@link markRelayRequest}.
 */
export type RequestTransportKind = "loopback" | "tailscale" | "tunnel" | "lan-or-proxy" | "k3relay";

/**
 * Sources of the requests the `RelayConnector` marked. The set is private to
 * this module and keyed by the request's `source`, which `modify` and the
 * decompression wrapper keep, so the mark follows a request through the router
 * and middleware. Nothing a peer sends (headers, address, URL) can add to it.
 */
const relayRequestSources = new WeakSet<object>();

type RelayMarkable = { readonly source?: object | undefined };

/**
 * Marks a request as having arrived through the relay and returns it. Only the
 * `RelayConnector` calls this, on the request it builds itself for each relayed
 * HTTP request or WebSocket upgrade. The mark is how `classifyRequestTransport`
 * knows the route; it is never read from a header.
 */
export const markRelayRequest = <R extends RelayMarkable>(request: R): R => {
  const source = request.source;
  if (typeof source !== "object" || source === null) {
    throw new TypeError("A relay request needs an object source to carry the relay mark.");
  }
  relayRequestSources.add(source);
  return request;
};

/** Whether the `RelayConnector` marked this request. */
export const isRelayRequest = (request: RelayMarkable): boolean => {
  const source = request.source;
  return typeof source === "object" && source !== null && relayRequestSources.has(source);
};

/**
 * The client address a relayed session records. It is not an IP address: a session with no
 * address counts as this machine's, so the relay needs a value that is neither empty nor loopback.
 */
export const RELAY_CLIENT_ADDRESS = "k3relay";

/**
 * The origin devices and the connector sign DPoP proofs against, since the host's real name
 * never reaches the relay. `requestUrl` gives relayed requests this origin and no other.
 */
export const RELAY_PROVISIONAL_HOST = "k3host.invalid";

const TUNNEL_HEADERS = ["cf-connecting-ip", "cf-ray"] as const;

const firstForwardedFor = (
  headers: HttpServerRequest.HttpServerRequest["headers"],
): string | undefined => {
  const forwarded = headers["x-forwarded-for"];
  if (typeof forwarded !== "string") return undefined;
  return forwarded
    .split(",")[0]
    ?.trim()
    .replace(/^\[|\]$/g, "");
};

const isTailscaleAddress = (address: string): boolean =>
  isSharedAddressSpaceHost(address) || isTailnetHost(address);

/**
 * Classifies the request by transport origin. A marked relay request is `k3relay` whatever its
 * headers say; an unmarked one never is. A loopback peer with forwarding headers is a local
 * proxy (Tailscale Serve, cloudflared): the client it forwards for decides the kind.
 */
export const classifyRequestTransport = (
  request: Pick<HttpServerRequest.HttpServerRequest, "remoteAddress" | "headers"> & RelayMarkable,
): RequestTransportKind => {
  // The route decides first: a device behind the relay controls every header it sends.
  if (isRelayRequest(request)) return "k3relay";
  const headers = request.headers;
  for (const header of TUNNEL_HEADERS) {
    if (headers[header] !== undefined) return "tunnel";
  }
  const peer = Option.getOrUndefined(request.remoteAddress);
  if (peer === undefined) return "lan-or-proxy";
  const normalizedPeer = peer.replace(/^::ffff:/i, "");
  if (isTailscaleAddress(normalizedPeer)) return "tailscale";
  if (isLocalLoopbackHost(normalizedPeer)) {
    const forwarded = firstForwardedFor(headers);
    if (forwarded === undefined) return "loopback";
    if (isTailscaleAddress(forwarded)) return "tailscale";
    if (isLocalLoopbackHost(forwarded)) return "loopback";
    return "lan-or-proxy";
  }
  return "lan-or-proxy";
};

/** Transports a `private-e2ee-only` server answers. */
export const isPrivateTransport = (kind: RequestTransportKind): boolean =>
  kind === "loopback" || kind === "tailscale";

export const transportAllowedByPolicy = (
  kind: RequestTransportKind,
  policy: RemoteTransportPolicy,
): boolean => policy === "any" || isPrivateTransport(kind);

/**
 * Whether the connection's own channel already is the end-to-end encryption `e2eeMode=require`
 * asks for. Loopback never leaves the machine; a `k3relay` request only exists inside the
 * device-authenticated E2E channel, so the inner `/ws` does not ask for a second layer.
 */
export const transportSatisfiesE2eeRequirement = (kind: RequestTransportKind): boolean =>
  kind === "loopback" || kind === "k3relay";
