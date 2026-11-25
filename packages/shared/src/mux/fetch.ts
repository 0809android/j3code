import * as Effect from "effect/Effect";

import type { MuxClient } from "./client.ts";
import { MuxResetCode, MuxStreamStateError } from "./errors.ts";
import type { MuxHeaders } from "./open.ts";
import type { MuxStream } from "./session.ts";

/** Where relative URLs resolve. Only path and query reach the host; the host name never leaves the device. */
export const MUX_DEFAULT_BASE_URL = "http://mux.invalid";

export type MuxFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MuxFetchOptions {
  readonly baseUrl?: string | undefined;
}

/** Statuses a `Response` cannot carry a body for. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("This operation was aborted", "AbortError");

const networkError = (cause: unknown) => new TypeError("fetch failed", { cause });

const pumpRequestBody = (body: ReadableStream<Uint8Array>, stream: MuxStream) =>
  Effect.acquireUseRelease(
    Effect.sync(() => body.getReader()),
    (reader) =>
      Effect.gen(function* () {
        while (true) {
          const result = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: () => new MuxStreamStateError({ detail: "The request body failed." }),
          });
          if (result.done) break;
          yield* stream.send(result.value);
        }
        yield* stream.close();
      }),
    (reader) => Effect.promise(() => reader.cancel().catch(() => undefined)),
  ).pipe(
    // The body is part of the request: if it breaks, the exchange is over.
    Effect.catch(() => stream.reset(MuxResetCode.Cancel, "The request body failed.")),
  );

/**
 * `fetch` over the mux. Request and response bodies stream with backpressure; an abort resets the
 * stream, so the host stops work. Redirects are not followed (the host's answer is returned as is).
 * Like the native one, a streaming request body needs `duplex: "half"` in `init`.
 */
export const makeMuxFetch = (client: MuxClient, options: MuxFetchOptions = {}): MuxFetch => {
  const baseUrl = options.baseUrl ?? MUX_DEFAULT_BASE_URL;

  return async (input, init) => {
    const request = new Request(
      typeof input === "string" || input instanceof URL ? new URL(input, baseUrl) : input,
      init,
    );
    const { signal } = request;
    if (signal.aborted) throw abortReason(signal);

    const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
      try {
        return await client.runPromise(effect, { signal });
      } catch (error) {
        throw signal.aborted ? abortReason(signal) : networkError(error);
      }
    };

    const url = new URL(request.url);
    const headers: MuxHeaders = [...request.headers];
    // Not tied to the signal: once OPEN is queued the stream exists and must be reset if we abort.
    const stream = await client
      .runPromise(
        client.open({
          kind: "http",
          method: request.method,
          path: url.pathname + url.search,
          headers,
        }),
      )
      .catch((error: unknown) => {
        throw networkError(error);
      });

    const cancel = (detail: string) => client.runFork(stream.reset(MuxResetCode.Cancel, detail));
    const onAbort = () => cancel("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    const detach = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      detach();
      cancel("aborted");
      throw abortReason(signal);
    }

    if (request.body === null) client.runFork(Effect.ignore(stream.close()));
    else client.runFork(pumpRequestBody(request.body, stream));

    const head = await run(stream.awaitResponse).catch((error: unknown) => {
      detach();
      cancel("no response");
      throw error;
    });
    if (head.status < 200) {
      detach();
      cancel("unexpected informational status");
      throw networkError(new Error(`Unexpected response status ${head.status}.`));
    }

    let body: ReadableStream<Uint8Array> | null = null;
    if (NULL_BODY_STATUSES.has(head.status)) {
      detach();
      cancel("no body");
    } else {
      body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const chunk = await client.runPromise(stream.read);
              if (chunk._tag === "End") {
                detach();
                controller.close();
              } else {
                controller.enqueue(chunk.bytes);
              }
            } catch (error) {
              detach();
              controller.error(signal.aborted ? abortReason(signal) : networkError(error));
            }
          },
          cancel() {
            detach();
            return client.runPromise(stream.reset(MuxResetCode.Cancel, "The body was cancelled."));
          },
        },
        { highWaterMark: 0 },
      );
    }

    const responseHeaders = new Headers(head.headers as Array<[string, string]>);
    try {
      return new Response(body, {
        status: head.status,
        ...(head.statusText === undefined ? {} : { statusText: head.statusText }),
        headers: responseHeaders,
      });
    } catch {
      return new Response(body, { status: head.status, headers: responseHeaders });
    }
  };
};
