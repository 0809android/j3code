import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { MuxResetCode, MuxStreamResetError, type MuxStreamError } from "./errors.ts";
import { MUX_DATA_CHUNK_BYTES } from "./frame.ts";
import type { MuxStream } from "./session.ts";

/**
 * WebSocket messages over a stream. A DATA payload is `[flags][bytes]`: bit 0 marks a binary
 * message, bit 1 the last fragment of a message. The close handshake rides on CLOSE:
 * `[code: u16][reason]`, empty meaning "no status".
 */

const FLAG_BINARY = 0b01;
const FLAG_FINAL = 0b10;
const FRAGMENT_BYTES = MUX_DATA_CHUNK_BYTES - 1;
export const MUX_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
export const WS_CLOSE_NO_STATUS = 1005;
const WS_CLOSE_REASON_BYTES = 123;

export type MuxMessage = string | Uint8Array;

export type MuxMessageEvent =
  | { readonly _tag: "Message"; readonly data: MuxMessage }
  | { readonly _tag: "Close"; readonly code: number; readonly reason: string };

export interface MuxMessageChannel {
  /** Next message, or `Close` once the peer closed (repeats). */
  readonly receive: Effect.Effect<MuxMessageEvent, MuxStreamError>;
  /** Messages until the peer closes. */
  readonly messages: Stream.Stream<MuxMessage, MuxStreamError>;
  /** The close code the peer sent, once `receive` has seen it. */
  readonly peerCloseCode: () => number | undefined;
  /** Messages stay whole when several fibers send at once. */
  readonly send: (message: MuxMessage) => Effect.Effect<void, MuxStreamError>;
  /** Our half of the close handshake. Idempotent. */
  readonly close: (code?: number, reason?: string) => Effect.Effect<void, MuxStreamError>;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const lenientDecoder = new TextDecoder();

const decodeText = (bytes: Uint8Array): string | undefined => {
  try {
    return textDecoder.decode(bytes);
  } catch {
    return undefined;
  }
};

const closePayload = (code: number, reason: string): Uint8Array => {
  const text = textEncoder.encode(reason).subarray(0, WS_CLOSE_REASON_BYTES);
  const payload = new Uint8Array(2 + text.length);
  new DataView(payload.buffer).setUint16(0, code);
  payload.set(text, 2);
  return payload;
};

export const makeMuxMessageChannel = (
  stream: MuxStream,
  options: { readonly maxMessageBytes?: number } = {},
): MuxMessageChannel => {
  const maxMessageBytes = options.maxMessageBytes ?? MUX_MAX_MESSAGE_BYTES;
  const sendLock = Semaphore.makeUnsafe(1);
  let fragments: Array<Uint8Array> = [];
  let fragmentBytes = 0;
  let fragmentBinary = false;
  let peerCloseCode: number | undefined;

  const protocolFailure = (detail: string) =>
    stream
      .reset(MuxResetCode.Protocol, detail)
      .pipe(
        Effect.andThen(
          Effect.fail(
            new MuxStreamResetError({ code: MuxResetCode.Protocol, detail, local: true }),
          ),
        ),
      );

  const receive: MuxMessageChannel["receive"] = Effect.gen(function* () {
    while (true) {
      const chunk = yield* stream.read;
      if (chunk._tag === "End") {
        const { payload } = chunk;
        if (payload.length < 2) {
          peerCloseCode = WS_CLOSE_NO_STATUS;
          return { _tag: "Close", code: WS_CLOSE_NO_STATUS, reason: "" };
        }
        peerCloseCode = new DataView(payload.buffer, payload.byteOffset, 2).getUint16(0);
        return {
          _tag: "Close",
          code: peerCloseCode,
          reason: lenientDecoder.decode(payload.subarray(2)),
        };
      }
      const flags = chunk.bytes[0]!;
      const binary = (flags & FLAG_BINARY) !== 0;
      if ((flags & ~(FLAG_BINARY | FLAG_FINAL)) !== 0) {
        return yield* protocolFailure("Unknown WebSocket fragment flags.");
      }
      if (fragments.length > 0 && binary !== fragmentBinary) {
        return yield* protocolFailure("A WebSocket message changed type between fragments.");
      }
      fragmentBinary = binary;
      fragmentBytes += chunk.bytes.length - 1;
      if (fragmentBytes > maxMessageBytes) {
        return yield* protocolFailure("A WebSocket message exceeds the size limit.");
      }
      fragments.push(chunk.bytes.subarray(1));
      if ((flags & FLAG_FINAL) === 0) continue;

      const parts = fragments;
      const total = fragmentBytes;
      fragments = [];
      fragmentBytes = 0;
      const data = parts.length === 1 ? parts[0]! : new Uint8Array(total);
      if (parts.length > 1) {
        let offset = 0;
        for (const part of parts) {
          data.set(part, offset);
          offset += part.length;
        }
      }
      if (binary) return { _tag: "Message", data };
      const text = decodeText(data);
      if (text === undefined) {
        return yield* protocolFailure("A WebSocket text message is not valid UTF-8.");
      }
      return { _tag: "Message", data: text };
    }
  });

  return {
    receive,
    peerCloseCode: () => peerCloseCode,
    messages: Stream.fromEffectRepeat(
      Effect.flatMap(receive, (event) =>
        event._tag === "Close" ? Cause.done() : Effect.succeed(event.data),
      ),
    ),
    send: (message) =>
      sendLock.withPermit(
        Effect.gen(function* () {
          const binary = typeof message !== "string";
          const bytes = binary ? message : textEncoder.encode(message);
          let offset = 0;
          let partial = false;
          // Fragments of a message that stops half way would glue onto the next one.
          yield* Effect.gen(function* () {
            do {
              const end = Math.min(offset + FRAGMENT_BYTES, bytes.length);
              const final = end === bytes.length;
              const payload = new Uint8Array(1 + end - offset);
              payload[0] = (binary ? FLAG_BINARY : 0) | (final ? FLAG_FINAL : 0);
              payload.set(bytes.subarray(offset, end), 1);
              partial = true;
              yield* stream.send(payload);
              partial = !final;
              offset = end;
            } while (offset < bytes.length);
          }).pipe(
            Effect.onInterrupt(() =>
              partial ? stream.reset(MuxResetCode.Cancel, "A message was cut short.") : Effect.void,
            ),
          );
        }),
      ),
    close: (code = 1000, reason = "") =>
      sendLock.withPermit(stream.close(closePayload(code, reason))),
  };
};
