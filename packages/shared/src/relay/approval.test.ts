import { assert, describe, it } from "@effect/vitest";

import {
  ADD_DEVICE_WINDOW_MS,
  type ApprovalPolicy,
  approvalRequired,
  consumeAddDeviceWindow,
  decideNewDeviceApproval,
  defaultApprovalPolicy,
  disableApproval,
  openAddDeviceWindow,
} from "./approval.ts";

const NOW = 1_800_000_000_000;
const hostWindow = openAddDeviceWindow({ kind: "host-user" }, NOW);

describe("new device approval", () => {
  it("is on by default and only turns off with a recorded choice", () => {
    assert.isTrue(approvalRequired(defaultApprovalPolicy));
    assert.isTrue(approvalRequired({ requireApproval: false, optOut: null }));
    const off = disableApproval(NOW);
    assert.isFalse(approvalRequired(off));
    assert.deepStrictEqual(off.optOut, { chosenAt: NOW, acknowledgedRisk: true });
  });

  it("refuses every new device outside the 10-minute add-device window", () => {
    for (const policy of [defaultApprovalPolicy, disableApproval(NOW)] satisfies ApprovalPolicy[]) {
      for (const route of ["qr", "account"] as const) {
        for (const [window, now] of [
          [null, NOW],
          [hostWindow, NOW + ADD_DEVICE_WINDOW_MS],
          [hostWindow, NOW - 1],
        ] as const) {
          assert.deepStrictEqual(decideNewDeviceApproval({ policy, window, route, now }), {
            kind: "reject",
            reason: "outside-window",
          });
        }
      }
    }
  });

  it("always asks for code comparison on QR pairing", () => {
    for (const policy of [defaultApprovalPolicy, disableApproval(NOW)]) {
      assert.deepStrictEqual(
        decideNewDeviceApproval({ policy, window: hostWindow, route: "qr", now: NOW }),
        { kind: "compare-code" },
      );
    }
  });

  it("allows one tap for the first device only, in a window the host user opened", () => {
    const decide = (window: typeof hostWindow) =>
      decideNewDeviceApproval({
        policy: defaultApprovalPolicy,
        window,
        route: "account",
        now: NOW + ADD_DEVICE_WINDOW_MS - 1,
      });
    assert.deepStrictEqual(decide(hostWindow), { kind: "one-tap" });
    assert.isNotNull(hostWindow);
    if (hostWindow === null) return;
    assert.deepStrictEqual(decide(consumeAddDeviceWindow(hostWindow)), { kind: "compare-code" });
    const deviceWindow = openAddDeviceWindow(
      { kind: "device", deviceId: "a".repeat(32), permissions: ["devices:invite"] },
      NOW,
    );
    assert.deepStrictEqual(decide(deviceWindow), { kind: "compare-code" });
    assert.deepStrictEqual(
      decideNewDeviceApproval({
        policy: disableApproval(NOW),
        window: hostWindow,
        route: "account",
        now: NOW,
      }),
      { kind: "auto-approve" },
    );
  });

  it("lets only devices with devices:invite open a window", () => {
    assert.isNull(
      openAddDeviceWindow({ kind: "device", deviceId: "a".repeat(32), permissions: [] }, NOW),
    );
  });
});
