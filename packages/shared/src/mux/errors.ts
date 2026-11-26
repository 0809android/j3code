import * as Schema from "effect/Schema";

/** A frame, or a message built from frames, broke the mux protocol. Fatal for the connection. */
export class MuxProtocolError extends Schema.TaggedError<MuxProtocolError>()("MuxProtocolError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** Why a stream was torn down before both directions closed. */
export const MuxResetCode = {
  /** One side no longer wants the stream (an abort, a cancelled body). */
  Cancel: 1,
  /** The peer is over a limit: too many streams, or too many unread bytes. */
  Refused: 2,
  /** The peer sent something this stream's state does not allow. */
  Protocol: 3,
  /** The handler failed or finished without answering. */
  Internal: 4,
} as const;
export type MuxResetCode = (typeof MuxResetCode)[keyof typeof MuxResetCode];

/** The peer reset the stream, or this side did. */
export class MuxStreamResetError extends Schema.TaggedError<MuxStreamResetError>()(
  "MuxStreamResetError",
  { code: Schema.Number, detail: Schema.String, local: Schema.Boolean },
) {
  override get message(): string {
    return `Mux stream reset (${this.code}${this.local ? ", local" : ""}): ${this.detail}`;
  }
}

/** The socket under the mux closed or failed; every stream ends with this. */
export class MuxConnectionClosedError extends Schema.TaggedError<MuxConnectionClosedError>()(
  "MuxConnectionClosedError",
  { detail: Schema.String, cause: Schema.optional(Schema.Unknown) },
) {
  override get message(): string {
    return `Mux connection closed: ${this.detail}`;
  }
}

/** A stream operation the stream's current state does not allow (send after close, oversized OPEN). */
export class MuxStreamStateError extends Schema.TaggedError<MuxStreamStateError>()(
  "MuxStreamStateError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Opening another stream would exceed the concurrent stream limit. */
export class MuxStreamLimitError extends Schema.TaggedError<MuxStreamLimitError>()(
  "MuxStreamLimitError",
  { limit: Schema.Number },
) {
  override get message(): string {
    return `Mux stream limit reached (${this.limit} concurrent streams).`;
  }
}

export type MuxStreamError = MuxStreamResetError | MuxConnectionClosedError | MuxStreamStateError;
