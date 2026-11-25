import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";

import type { MuxClient } from "./client.ts";
import { MuxResetCode } from "./errors.ts";
import { makeMuxMessageChannel } from "./messageChannel.ts";
import type { MuxStream } from "./session.ts";
import { MUX_DEFAULT_BASE_URL } from "./fetch.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** How long a side that asked to close waits for the other side's answer. */
const CLOSE_HANDSHAKE_TIMEOUT = "5 seconds";
const ABNORMAL_CLOSURE = 1006;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface MuxWebSocketEvent {
  readonly type: "open" | "message" | "error" | "close";
  readonly target: MuxWebSocketInstance;
  readonly data?: string | ArrayBuffer | Blob;
  readonly code?: number;
  readonly reason?: string;
  readonly wasClean?: boolean;
}

type Listener = (event: MuxWebSocketEvent) => void;

/** What the browser's `WebSocket` offers, minus what a mux has no use for (`extensions`, handshake headers). */
export interface MuxWebSocketInstance {
  readonly url: string;
  readonly protocol: string;
  readonly extensions: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: "blob" | "arraybuffer";
  onopen: Listener | null;
  onmessage: Listener | null;
  onerror: Listener | null;
  onclose: Listener | null;
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: MuxWebSocketEvent["type"],
    listener: Listener,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: MuxWebSocketEvent["type"], listener: Listener): void;
}

export interface MuxWebSocketConstructor {
  new (url: string | URL, protocols?: string | ReadonlyArray<string>): MuxWebSocketInstance;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
}

export interface MuxWebSocketOptions {
  readonly baseUrl?: string | undefined;
}

type Outgoing =
  | { readonly kind: "message"; readonly data: string | Uint8Array | Blob; readonly size: number }
  | { readonly kind: "close"; readonly code: number; readonly reason: string };

const domError = (message: string, name: string) => new DOMException(message, name);

const toBytes = (data: ArrayBuffer | ArrayBufferView): Uint8Array =>
  data instanceof ArrayBuffer
    ? new Uint8Array(data.slice(0))
    : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));

/**
 * A `WebSocket` over the mux, for code that expects the browser class (it is what `Socket`'s
 * WebSocket constructor service builds on). Events are plain objects, so it needs no `EventTarget`.
 */
export const makeMuxWebSocket = (
  client: MuxClient,
  options: MuxWebSocketOptions = {},
): MuxWebSocketConstructor => {
  const baseUrl = options.baseUrl ?? MUX_DEFAULT_BASE_URL;

  class MuxWebSocket implements MuxWebSocketInstance {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSING = CLOSING;
    static readonly CLOSED = CLOSED;

    readonly url: string;
    protocol = "";
    readonly extensions = "";
    binaryType: "blob" | "arraybuffer" = "blob";
    onopen: Listener | null = null;
    onmessage: Listener | null = null;
    onerror: Listener | null = null;
    onclose: Listener | null = null;

    #readyState = CONNECTING;
    #buffered = 0;
    #listeners = new Map<string, Set<Listener>>();
    #outgoing = Effect.runSync(Queue.unbounded<Outgoing>());
    #stream: MuxStream | undefined;
    #driver: Fiber.Fiber<void, never> | undefined;
    #settled = false;

    constructor(url: string | URL, protocols: string | ReadonlyArray<string> = []) {
      const parsed = new URL(url, baseUrl);
      if (!/^(wss?|https?):$/.test(parsed.protocol)) {
        throw domError("The URL's scheme must be ws, wss, http or https.", "SyntaxError");
      }
      if (parsed.hash !== "") throw domError("The URL contains a fragment.", "SyntaxError");
      const offered = typeof protocols === "string" ? [protocols] : [...protocols];
      if (offered.some((entry) => !TOKEN.test(entry)) || new Set(offered).size !== offered.length) {
        throw domError("Invalid subprotocol.", "SyntaxError");
      }
      this.url = parsed.href;
      this.#driver = client.runFork(this.#drive(parsed.pathname + parsed.search, offered));
    }

    get readyState() {
      return this.#readyState;
    }

    get bufferedAmount() {
      return this.#buffered;
    }

    addEventListener(
      type: MuxWebSocketEvent["type"],
      listener: Listener,
      options?: { readonly once?: boolean },
    ) {
      const set = this.#listeners.get(type) ?? new Set<Listener>();
      this.#listeners.set(type, set);
      if (options?.once === true) {
        const once: Listener = (event) => {
          set.delete(once);
          listener(event);
        };
        set.add(once);
      } else {
        set.add(listener);
      }
    }

    removeEventListener(type: MuxWebSocketEvent["type"], listener: Listener) {
      this.#listeners.get(type)?.delete(listener);
    }

    send(data: string | ArrayBuffer | ArrayBufferView | Blob) {
      if (this.#readyState === CONNECTING) {
        throw domError("The WebSocket is still connecting.", "InvalidStateError");
      }
      if (this.#readyState !== OPEN) return;
      const payload = typeof data === "string" || data instanceof Blob ? data : toBytes(data);
      const size =
        typeof payload === "string"
          ? new TextEncoder().encode(payload).length
          : payload instanceof Blob
            ? payload.size
            : payload.length;
      this.#buffered += size;
      Queue.offerUnsafe(this.#outgoing, { kind: "message", data: payload, size });
    }

    close(code?: number, reason = "") {
      if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
        throw domError("The close code must be 1000 or in 3000-4999.", "InvalidAccessError");
      }
      if (new TextEncoder().encode(reason).length > 123) {
        throw domError("The close reason exceeds 123 bytes.", "SyntaxError");
      }
      if (this.#readyState === CLOSING || this.#readyState === CLOSED) return;
      if (this.#readyState === CONNECTING) {
        this.#driver?.interruptUnsafe();
        if (this.#stream !== undefined) {
          client.runFork(this.#stream.reset(MuxResetCode.Cancel, "closed while connecting"));
        }
        this.#fail();
        return;
      }
      this.#readyState = CLOSING;
      Queue.offerUnsafe(this.#outgoing, { kind: "close", code: code ?? 1000, reason });
    }

    #dispatch(event: Omit<MuxWebSocketEvent, "target">) {
      const full = { ...event, target: this } as MuxWebSocketEvent;
      const handler = {
        open: this.onopen,
        message: this.onmessage,
        error: this.onerror,
        close: this.onclose,
      }[event.type];
      for (const listener of this.#listeners.get(event.type) ?? []) listener(full);
      handler?.(full);
    }

    /** The connection is over without a clean handshake: error, then close with 1006. */
    #fail() {
      if (this.#settled) return;
      this.#settled = true;
      this.#readyState = CLOSED;
      this.#dispatch({ type: "error" });
      this.#dispatch({ type: "close", code: ABNORMAL_CLOSURE, reason: "", wasClean: false });
    }

    #finish(code: number, reason: string) {
      if (this.#settled) return;
      this.#settled = true;
      this.#readyState = CLOSED;
      this.#dispatch({ type: "close", code, reason, wasClean: true });
    }

    #deliver(data: string | Uint8Array) {
      if (typeof data === "string") {
        this.#dispatch({ type: "message", data });
      } else if (this.binaryType === "arraybuffer" || typeof Blob === "undefined") {
        this.#dispatch({
          type: "message",
          data: data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength,
          ) as ArrayBuffer,
        });
      } else {
        this.#dispatch({ type: "message", data: new Blob([data as Uint8Array<ArrayBuffer>]) });
      }
    }

    #drive(path: string, offered: ReadonlyArray<string>) {
      const socket = this;
      return Effect.gen(function* () {
        // Like a browser, never call handlers before the constructor's caller has attached them.
        yield* Effect.yieldNow;
        const stream = yield* client.open({
          kind: "ws",
          path,
          headers: [],
          protocols: offered,
        });
        socket.#stream = stream;
        const head = yield* stream.awaitResponse;
        if (
          head.status !== 101 ||
          (head.protocol !== undefined && !offered.includes(head.protocol))
        ) {
          return yield* stream
            .reset(MuxResetCode.Cancel, "The upgrade was refused.")
            .pipe(Effect.andThen(Effect.fail("refused" as const)));
        }
        const channel = makeMuxMessageChannel(stream);
        socket.protocol = head.protocol ?? "";
        socket.#readyState = OPEN;
        socket.#dispatch({ type: "open" });

        const peerClosed = yield* Deferred.make<{ code: number; reason: string }>();
        const receive = Effect.gen(function* () {
          while (true) {
            const event = yield* channel.receive;
            if (event._tag === "Close") {
              if (socket.#readyState === OPEN) {
                socket.#readyState = CLOSING;
                Queue.offerUnsafe(socket.#outgoing, {
                  kind: "close",
                  code: event.code === 1005 ? 1000 : event.code,
                  reason: "",
                });
              }
              yield* Deferred.succeed(peerClosed, { code: event.code, reason: event.reason });
              return;
            }
            socket.#deliver(event.data);
          }
        });
        const send = Effect.gen(function* () {
          while (true) {
            const next = yield* Queue.take(socket.#outgoing);
            if (next.kind === "close") {
              yield* channel.close(next.code, next.reason);
              return;
            }
            const data =
              next.data instanceof Blob
                ? new Uint8Array(yield* Effect.promise(() => (next.data as Blob).arrayBuffer()))
                : next.data;
            yield* channel.send(data);
            socket.#buffered -= next.size;
          }
        });
        yield* Effect.all(
          [
            receive,
            send.pipe(
              Effect.andThen(
                Deferred.await(peerClosed).pipe(Effect.timeout(CLOSE_HANDSHAKE_TIMEOUT)),
              ),
            ),
          ],
          {
            concurrency: 2,
            discard: true,
          },
        );
        const closed = yield* Deferred.await(peerClosed);
        socket.#finish(closed.code, closed.reason);
      }).pipe(
        Effect.catchCause(() =>
          Effect.suspend(() => {
            socket.#fail();
            return socket.#stream === undefined
              ? Effect.void
              : socket.#stream.reset(MuxResetCode.Cancel, "The WebSocket failed.");
          }),
        ),
      );
    }
  }

  return MuxWebSocket as MuxWebSocketConstructor;
};
