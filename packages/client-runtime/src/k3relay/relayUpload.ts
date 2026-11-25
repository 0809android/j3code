import type { ConnectionTransport } from "../connection/model.ts";

/**
 * Sends an attachment's bytes to the upload slot over a relay channel's `fetch` (spec §12). A
 * `Blob` streams in pieces with progress; plain bytes (React Native, which has no streams) go
 * whole. The slot is a relay handle, so the request carries no credential of its own.
 */
export const uploadThroughRelay = async (input: {
  readonly transport: ConnectionTransport;
  readonly url: string;
  readonly body: Blob | Uint8Array;
  readonly mimeType: string;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: number) => void) | undefined;
}): Promise<void> => {
  const total = input.body instanceof Uint8Array ? input.body.byteLength : input.body.size;
  let body: BodyInit;
  if (input.body instanceof Uint8Array || typeof ReadableStream !== "function") {
    body = input.body as BodyInit;
  } else {
    const reader = input.body.stream().getReader();
    let sent = 0;
    body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        sent += value.byteLength;
        input.onProgress?.(total === 0 ? 1 : sent / total);
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
  }
  const response = await input.transport.fetch(input.url, {
    method: "POST",
    headers: { "content-type": input.mimeType, "content-length": String(total) },
    body,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (response.status !== 204 && !response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    throw new Error(detail === "" ? `Upload failed (${response.status}).` : detail);
  }
  await response.body?.cancel().catch(() => undefined);
  input.onProgress?.(1);
};
