/**
 * `EventSource` over any `fetch`, such as the relay mux's (spec §12): the browser's own cannot
 * take another transport. It follows the HTML standard's parsing and reconnection: `retry`, the
 * `Last-Event-ID` header on reconnect, and a final close on a non-200 or non-event-stream answer.
 * It needs no `EventTarget`, which React Native lacks.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchEventSourceMessage {
  readonly type: string;
  readonly data: string;
  readonly lastEventId: string;
  readonly origin: string;
}

type Listener = (event: FetchEventSourceMessage | { readonly type: string }) => void;

export interface FetchEventSourceOptions {
  /** Milliseconds before reconnecting until the server sends `retry:`. */
  readonly retryMs?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Schedules a reconnect; returns its cancel. Defaults to a timer. */
  readonly schedule?: ((run: () => void, ms: number) => () => void) | undefined;
}

const scheduleWithTimer = (run: () => void, ms: number) => {
  // @effect-diagnostics-next-line globalTimers:off -- a DOM-shaped class outside any Effect runtime.
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

const DEFAULT_RETRY_MS = 3_000;

export interface FetchEventSourceInstance {
  readonly url: string;
  readonly readyState: number;
  readonly withCredentials: false;
  onopen: ((event: { readonly type: "open" }) => void) | null;
  onmessage: ((event: FetchEventSourceMessage) => void) | null;
  onerror: ((event: { readonly type: "error" }) => void) | null;
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  close(): void;
}

export interface FetchEventSourceConstructor {
  new (url: string, init?: FetchEventSourceOptions): FetchEventSourceInstance;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSED: 2;
}

export const makeFetchEventSource = (fetch: FetchLike): FetchEventSourceConstructor => {
  class FetchEventSource implements FetchEventSourceInstance {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSED = CLOSED;

    readonly url: string;
    readonly withCredentials = false as const;
    readyState: number = CONNECTING;
    onopen: ((event: { readonly type: "open" }) => void) | null = null;
    onmessage: ((event: FetchEventSourceMessage) => void) | null = null;
    onerror: ((event: { readonly type: "error" }) => void) | null = null;

    #listeners = new Map<string, Set<Listener>>();
    #retryMs: number;
    #headers: Readonly<Record<string, string>>;
    #lastEventId = "";
    #abort: AbortController | null = null;
    #cancelReconnect: (() => void) | null = null;
    #schedule: (run: () => void, ms: number) => () => void;

    constructor(url: string, init: FetchEventSourceOptions = {}) {
      this.url = url;
      this.#retryMs = init.retryMs ?? DEFAULT_RETRY_MS;
      this.#headers = init.headers ?? {};
      this.#schedule = init.schedule ?? scheduleWithTimer;
      void this.#connect();
    }

    addEventListener(type: string, listener: Listener) {
      let set = this.#listeners.get(type);
      if (set === undefined) {
        set = new Set();
        this.#listeners.set(type, set);
      }
      set.add(listener);
    }

    removeEventListener(type: string, listener: Listener) {
      this.#listeners.get(type)?.delete(listener);
    }

    close() {
      this.readyState = CLOSED;
      this.#cancelReconnect?.();
      this.#cancelReconnect = null;
      this.#abort?.abort();
      this.#abort = null;
    }

    #emit(event: FetchEventSourceMessage | { readonly type: string }) {
      if (event.type === "open") this.onopen?.(event as { readonly type: "open" });
      else if (event.type === "error") this.onerror?.(event as { readonly type: "error" });
      else if (event.type === "message") this.onmessage?.(event as FetchEventSourceMessage);
      for (const listener of this.#listeners.get(event.type) ?? []) listener(event);
    }

    #fail() {
      this.close();
      this.#emit({ type: "error" });
    }

    #reconnect() {
      if (this.readyState === CLOSED) return;
      this.readyState = CONNECTING;
      this.#emit({ type: "error" });
      if (this.readyState === CLOSED) return;
      this.#cancelReconnect = this.#schedule(() => {
        this.#cancelReconnect = null;
        void this.#connect();
      }, this.#retryMs);
    }

    async #connect() {
      if (this.readyState === CLOSED) return;
      const abort = new AbortController();
      this.#abort = abort;
      let response: Response;
      try {
        response = await fetch(this.url, {
          headers: {
            accept: "text/event-stream",
            "cache-control": "no-store",
            ...this.#headers,
            ...(this.#lastEventId === "" ? {} : { "last-event-id": this.#lastEventId }),
          },
          signal: abort.signal,
        });
      } catch {
        if (!abort.signal.aborted) this.#reconnect();
        return;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (
        response.status !== 200 ||
        !/^text\/event-stream\b/iu.test(contentType) ||
        response.body === null
      ) {
        await response.body?.cancel().catch(() => undefined);
        // The standard's "fail the connection": no reconnect.
        if (!abort.signal.aborted) this.#fail();
        return;
      }
      if (this.readyState === CLOSED) {
        await response.body.cancel().catch(() => undefined);
        return;
      }
      this.readyState = OPEN;
      this.#emit({ type: "open" });
      try {
        await this.#read(response.body);
      } catch {
        // A dropped stream reconnects below, like one that ended.
      }
      if (!abort.signal.aborted) this.#reconnect();
    }

    async #read(body: ReadableStream<Uint8Array>) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let data: Array<string> = [];
      let type = "";
      let pendingId: string | null = null;
      const origin = (() => {
        try {
          return new URL(this.url).origin;
        } catch {
          return "";
        }
      })();
      const dispatch = () => {
        if (pendingId !== null) this.#lastEventId = pendingId;
        pendingId = null;
        if (data.length === 0) {
          type = "";
          return;
        }
        const event: FetchEventSourceMessage = {
          type: type === "" ? "message" : type,
          data: data.join("\n"),
          lastEventId: this.#lastEventId,
          origin,
        };
        data = [];
        type = "";
        if (this.readyState !== CLOSED) this.#emit(event);
      };
      const line = (text: string) => {
        if (text === "") return dispatch();
        if (text.startsWith(":")) return;
        const colon = text.indexOf(":");
        const field = colon === -1 ? text : text.slice(0, colon);
        let value = colon === -1 ? "" : text.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        switch (field) {
          case "data":
            data.push(value);
            break;
          case "event":
            type = value;
            break;
          case "id":
            if (!value.includes("\0")) pendingId = value;
            break;
          case "retry":
            if (/^\d+$/u.test(value)) this.#retryMs = Number(value);
            break;
        }
      };
      let first = true;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (first) {
          // A byte order mark is not part of the stream.
          buffer = buffer.replace(/^﻿/u, "");
          first = false;
        }
        let index: number;
        while ((index = buffer.search(/\r\n|\r|\n/u)) !== -1) {
          // A lone \r at the end may be the first half of \r\n: wait for more.
          if (buffer[index] === "\r" && index === buffer.length - 1) break;
          const breakLength = buffer.startsWith("\r\n", index) ? 2 : 1;
          line(buffer.slice(0, index));
          buffer = buffer.slice(index + breakLength);
        }
        if (this.readyState === CLOSED) {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    }
  }
  return FetchEventSource;
};
