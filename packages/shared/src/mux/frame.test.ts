import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  decodeFrame,
  encodeFrame,
  encodeResetPayload,
  encodeWindowPayload,
  MUX_FRAME_HEADER_BYTES,
  MUX_MAX_PAYLOAD_BYTES,
  type MuxFrame,
  MuxFrameType,
} from "./frame.ts";
import { decodeOpen, decodeResponseHead, sanitizeForwardedHeaders } from "./open.ts";

const encoder = new TextEncoder();

const rawFrame = (streamId: number, type: number, length: number, payload: Uint8Array) => {
  const bytes = new Uint8Array(MUX_FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, streamId);
  bytes[4] = type;
  view.setUint32(5, length);
  bytes.set(payload, MUX_FRAME_HEADER_BYTES);
  return bytes;
};

const decodeFailure = (bytes: Uint8Array) => {
  const result = decodeFrame(bytes);
  assert.isTrue(Result.isFailure(result), "expected a rejection");
  return Result.isFailure(result) ? result.failure.detail : "";
};

describe("mux frames", () => {
  it("round-trips every frame type, including the largest payload and the largest stream id", () => {
    const frames: ReadonlyArray<MuxFrame> = [
      { streamId: 1, type: MuxFrameType.Open, payload: encoder.encode("{}") },
      {
        streamId: 2,
        type: MuxFrameType.Data,
        payload: new Uint8Array(MUX_MAX_PAYLOAD_BYTES).fill(7),
      },
      { streamId: 0xffff_ffff, type: MuxFrameType.Close, payload: new Uint8Array(0) },
      { streamId: 3, type: MuxFrameType.Window, payload: encodeWindowPayload(65536) },
      { streamId: 4, type: MuxFrameType.Reset, payload: encodeResetPayload(2, "full") },
    ];
    for (const frame of frames) {
      const decoded = decodeFrame(encodeFrame(frame));
      assert.isTrue(Result.isSuccess(decoded));
      if (Result.isSuccess(decoded)) assert.deepStrictEqual(decoded.success, frame);
    }
  });

  it("refuses to encode what the protocol forbids", () => {
    assert.throws(() =>
      encodeFrame({
        streamId: 1,
        type: MuxFrameType.Data,
        payload: new Uint8Array(MUX_MAX_PAYLOAD_BYTES + 1),
      }),
    );
    assert.throws(() =>
      encodeFrame({ streamId: 0, type: MuxFrameType.Close, payload: new Uint8Array(0) }),
    );
  });

  it("rejects frames that are malformed", () => {
    const data = new Uint8Array([1, 2, 3]);
    const cases: ReadonlyArray<readonly [string, Uint8Array, string]> = [
      ["shorter than a header", new Uint8Array(8), "Truncated mux frame header"],
      ["stream id 0", rawFrame(0, MuxFrameType.Data, 3, data), "reserved"],
      ["unknown type", rawFrame(1, 9, 3, data), "Unknown mux frame type"],
      ["type 0", rawFrame(1, 0, 3, data), "Unknown mux frame type"],
      [
        "declared length over the limit",
        rawFrame(
          1,
          MuxFrameType.Data,
          MUX_MAX_PAYLOAD_BYTES + 1,
          new Uint8Array(MUX_MAX_PAYLOAD_BYTES + 1),
        ),
        "exceeds the 16 KiB limit",
      ],
      [
        "cut off inside the payload",
        rawFrame(1, MuxFrameType.Data, 10, data),
        "Truncated mux frame payload",
      ],
      ["bytes after the payload", rawFrame(1, MuxFrameType.Data, 2, data), "Trailing bytes"],
      ["empty DATA", rawFrame(1, MuxFrameType.Data, 0, new Uint8Array(0)), "Empty mux DATA"],
      ["empty OPEN", rawFrame(1, MuxFrameType.Open, 0, new Uint8Array(0)), "Empty mux OPEN"],
      ["WINDOW of the wrong size", rawFrame(1, MuxFrameType.Window, 3, data), "exactly 4 bytes"],
      [
        "WINDOW of zero",
        rawFrame(1, MuxFrameType.Window, 4, new Uint8Array(4)),
        "must be positive",
      ],
      ["RESET without a code", rawFrame(1, MuxFrameType.Reset, 3, data), "4-byte code"],
    ];
    for (const [name, bytes, detail] of cases) {
      assert.include(decodeFailure(bytes), detail, name);
    }
  });
});

describe("mux OPEN metadata", () => {
  const open = (value: unknown) => decodeOpen(encoder.encode(JSON.stringify(value)));

  it("decodes HTTP and WebSocket opens and keeps repeated headers", () => {
    const http = open({
      kind: "http",
      method: "POST",
      path: "/api/auth/session?x=1",
      headers: [
        ["accept", "a"],
        ["accept", "b"],
      ],
    });
    assert.deepStrictEqual(Result.isSuccess(http) ? http.success : undefined, {
      kind: "http",
      method: "POST",
      path: "/api/auth/session?x=1",
      headers: [
        ["accept", "a"],
        ["accept", "b"],
      ],
    });
    const ws = open({ kind: "ws", path: "/ws?ticket=t", headers: [], protocols: ["a.b"] });
    assert.isTrue(Result.isSuccess(ws));
  });

  it("rejects metadata a handler must never see", () => {
    const base = { kind: "http", method: "GET", path: "/", headers: [] };
    const bad: ReadonlyArray<unknown> = [
      null,
      { ...base, kind: "tcp" },
      { ...base, path: "http://evil.example/" },
      { ...base, path: "/a b" },
      { ...base, method: "GE T" },
      { ...base, headers: [["bad name", "x"]] },
      { ...base, headers: [["x", "line\r\nbreak"]] },
      { ...base, headers: [["x"]] },
      { kind: "ws", path: "/", headers: [], protocols: [1] },
    ];
    for (const value of bad) assert.isTrue(Result.isFailure(open(value)), JSON.stringify(value));
    assert.isTrue(Result.isFailure(decodeOpen(encoder.encode("{not json"))));
  });

  it("validates response heads", () => {
    const head = (value: unknown) => decodeResponseHead(encoder.encode(JSON.stringify(value)));
    assert.isTrue(Result.isSuccess(head({ status: 200, headers: [["a", "b"]] })));
    assert.isTrue(Result.isFailure(head({ status: 99, headers: [] })));
    assert.isTrue(Result.isFailure(head({ status: 200.5, headers: [] })));
    assert.isTrue(Result.isFailure(head({ status: 200 })));
  });

  it("strips forwarding headers case-insensitively and keeps the rest", () => {
    const headers = sanitizeForwardedHeaders([
      ["X-Forwarded-For", "1.2.3.4"],
      ["x-forwarded-proto", "https"],
      ["x-forwarded-host", "h"],
      ["CF-Connecting-IP", "1.2.3.4"],
      ["cf-ray", "abc"],
      ["Forwarded", "for=1.2.3.4"],
      ["x-real-ip", "1.2.3.4"],
      ["authorization", "Bearer t"],
      ["x-forward", "kept"],
    ]);
    assert.deepStrictEqual(headers, [
      ["authorization", "Bearer t"],
      ["x-forward", "kept"],
    ]);
  });
});
