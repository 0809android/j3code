import { assert, describe, it } from "@effect/vitest";
import { E2eeRejectedError } from "@t3tools/shared/socketE2ee";
import * as Socket from "effect/socket/Socket";

import { K3RelayAdmissionError, findK3RelayFailureReason } from "./admission.ts";
import { presentConnectionDiagnosis } from "../connection/diagnosis.ts";
import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import {
  k3relayCloseReason,
  k3relayConnectionError,
  k3relayFailureText,
  k3relayNeedsRepair,
} from "./failure.ts";

describe("K3 Relay failure reasons", () => {
  it("diagnoses a revoked device at the host, with re-pairing as the way out", () => {
    const failure = k3relayConnectionError("revoked", "Studio Mac");
    const diagnosis = presentConnectionDiagnosis({
      hostLabel: "Studio Mac",
      via: "direct",
      state: { ...AVAILABLE_CONNECTION_STATE, phase: "blocked", lastFailure: failure },
    });
    assert.strictEqual(diagnosis?.headline, failure.detail);
    assert.deepStrictEqual(
      diagnosis?.hops.map((hop) => [hop.label, hop.result]),
      [
        ["This device", "ok"],
        ["K3 Relay", "ok"],
        ["K3 Code on Studio Mac", "failed"],
      ],
    );
    assert.include(diagnosis?.steps[0] ?? "", "pair this device again");
    assert.isNull(diagnosis?.moreInfoUrl ?? null);
  });

  it("maps the relay's close codes to reasons a screen can name", () => {
    assert.strictEqual(k3relayCloseReason(4403), "revoked");
    assert.strictEqual(k3relayCloseReason(4410), "grant-expired");
    assert.strictEqual(k3relayCloseReason(4404), "host-offline");
    assert.strictEqual(k3relayCloseReason(4423), "blocked");
    assert.strictEqual(k3relayCloseReason(4429, "degraded"), "degraded");
    assert.strictEqual(k3relayCloseReason(4429, "limit"), "limit");
    assert.strictEqual(k3relayCloseReason(4401), "unauthorized");
    assert.isNull(k3relayCloseReason(1000));
  });

  it("finds the host's verdict however deep the layers wrapped it", () => {
    const wrapped = new Socket.SocketError({
      reason: new Socket.SocketReadError({ cause: new E2eeRejectedError({ reason: "revoked" }) }),
    });
    assert.strictEqual(findK3RelayFailureReason({ cause: wrapped }), "revoked");
    const closed = new Socket.SocketError({
      reason: new Socket.SocketCloseError({ code: 4410 }),
    });
    assert.strictEqual(findK3RelayFailureReason(closed), "grant-expired");
    assert.strictEqual(
      findK3RelayFailureReason(new K3RelayAdmissionError({ reason: "blocked", detail: "x" })),
      "blocked",
    );
    assert.isNull(findK3RelayFailureReason(new Error("plain")));
  });

  it("stops retrying on refusals, keeps retrying on outages, and says why", () => {
    const revoked = k3relayConnectionError("revoked", "Studio Mac");
    assert.strictEqual(revoked._tag, "ConnectionBlockedError");
    assert.strictEqual(revoked.k3relayReason, "revoked");
    assert.strictEqual(
      revoked.detail,
      "Studio Mac revoked this device. Pair it again to reconnect.",
    );
    const offline = k3relayConnectionError("host-offline", "Studio Mac");
    assert.strictEqual(offline._tag, "ConnectionTransientError");
    assert.isTrue(k3relayNeedsRepair("revoked"));
    assert.isFalse(k3relayNeedsRepair("host-offline"));
    assert.include(k3relayFailureText("degraded", "Studio Mac"), "LAN and VPN");
  });
});
