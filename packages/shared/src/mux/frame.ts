import * as Result from "effect/Result";

import { MuxProtocolError } from "./errors.ts";

/**
 * `[streamId: u32][type: u8][length: u32][payload]`, big-endian, one frame per socket message.
 * The payload never exceeds 16 KiB. Frames are decoded strictly: a frame that does not fit its
 * own length, or that no stream state could have produced, ends the connection.
 */

export const MUX_FRAME_HEADER_BYTES = 9;
export const MUX_MAX_PAYLOAD_BYTES = 16 * 1024;
/**
 * The most DATA a sender puts in one frame. The E2EE channel fragments at 16 KiB, so a frame
 * that fits that size, header included, travels as one record instead of two.
 */
export const MUX_DATA_CHUNK_BYTES = MUX_MAX_PAYLOAD_BYTES - MUX_FRAME_HEADER_BYTES;
export const MUX_MAX_STREAM_ID = 0xffff_ffff;
export const MUX_MAX_WINDOW_BYTES = 0x7fff_ffff;

export const MuxFrameType = {
  /** Starts a stream (peer) or answers it (the responder's head). Payload: JSON metadata. */
  Open: 1,
  /** Stream bytes. Counts against the flow-control window. */
  Data: 2,
  /** The sender will send nothing more (half-close). Payload: optional, protocol specific. */
  Close: 3,
  /** Returns flow-control credit. Payload: u32 increment. */
  Window: 4,
  /** Tears the stream down in both directions. Payload: u32 code, then an optional UTF-8 detail. */
  Reset: 5,
} as const;
export type MuxFrameType = (typeof MuxFrameType)[keyof typeof MuxFrameType];

export interface MuxFrame {
  readonly streamId: number;
  readonly type: MuxFrameType;
  readonly payload: Uint8Array;
}

const isFrameType = (value: number): value is MuxFrameType =>
  value >= MuxFrameType.Open && value <= MuxFrameType.Reset;

export const encodeFrame = (frame: MuxFrame): Uint8Array => {
  const { streamId, type, payload } = frame;
  if (!Number.isInteger(streamId) || streamId < 1 || streamId > MUX_MAX_STREAM_ID) {
    throw new RangeError(`Invalid mux stream id ${streamId}.`);
  }
  if (payload.length > MUX_MAX_PAYLOAD_BYTES) {
    throw new RangeError(`Mux payload of ${payload.length} bytes exceeds the 16 KiB limit.`);
  }
  const bytes = new Uint8Array(MUX_FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, streamId);
  bytes[4] = type;
  view.setUint32(5, payload.length);
  bytes.set(payload, MUX_FRAME_HEADER_BYTES);
  return bytes;
};

const reject = (detail: string) => Result.fail(new MuxProtocolError({ detail }));

export const decodeFrame = (bytes: Uint8Array): Result.Result<MuxFrame, MuxProtocolError> => {
  if (bytes.length < MUX_FRAME_HEADER_BYTES) return reject("Truncated mux frame header.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const streamId = view.getUint32(0);
  const type = bytes[4]!;
  const length = view.getUint32(5);
  if (streamId === 0) return reject("Mux stream id 0 is reserved.");
  if (!isFrameType(type)) return reject(`Unknown mux frame type ${type}.`);
  if (length > MUX_MAX_PAYLOAD_BYTES) {
    return reject(`Mux payload of ${length} bytes exceeds the 16 KiB limit.`);
  }
  if (bytes.length < MUX_FRAME_HEADER_BYTES + length) return reject("Truncated mux frame payload.");
  if (bytes.length > MUX_FRAME_HEADER_BYTES + length) {
    return reject("Trailing bytes after the mux frame payload.");
  }
  const payload = bytes.subarray(MUX_FRAME_HEADER_BYTES);
  switch (type) {
    case MuxFrameType.Open:
      if (length === 0) return reject("Empty mux OPEN payload.");
      break;
    case MuxFrameType.Data:
      if (length === 0) return reject("Empty mux DATA payload.");
      break;
    case MuxFrameType.Window:
      if (length !== 4) return reject("A mux WINDOW payload is exactly 4 bytes.");
      if (new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0) === 0) {
        return reject("A mux WINDOW increment must be positive.");
      }
      break;
    case MuxFrameType.Reset:
      if (length < 4) return reject("A mux RESET payload starts with a 4-byte code.");
      break;
    case MuxFrameType.Close:
      break;
  }
  return Result.succeed({ streamId, type, payload });
};

export const encodeWindowPayload = (increment: number): Uint8Array => {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, increment);
  return payload;
};

export const decodeWindowPayload = (payload: Uint8Array): number =>
  new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const encodeResetPayload = (code: number, detail: string): Uint8Array => {
  const text = textEncoder.encode(detail).subarray(0, 1024);
  const payload = new Uint8Array(4 + text.length);
  new DataView(payload.buffer).setUint32(0, code);
  payload.set(text, 4);
  return payload;
};

export const decodeResetPayload = (payload: Uint8Array): { code: number; detail: string } => ({
  code: new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0),
  detail: textDecoder.decode(payload.subarray(4)),
});
