import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PreparedConnection } from "../connection/model.ts";

/**
 * Assets through a K3 relay (spec §12). `<img>`, `<video>` and downloads load a URL with the
 * platform's own networking, which cannot reach a host behind the relay. So the bytes come over
 * the mux `fetch` and the platform gets a local URL instead: a `blob:` URL on web and desktop, a
 * `file://` URI on mobile. The cache bounds what it holds and how much it fetches at once.
 */

/** Where fetched bytes become a URL the platform can load, and stop being one. */
export interface RelayAssetStore {
  readonly put: (input: {
    readonly bytes: Uint8Array;
    readonly mimeType: string | null;
    readonly fileName: string;
  }) => Promise<string>;
  readonly release: (url: string) => void;
}

/** Web and desktop: a `blob:` URL, revoked when the cache lets it go. */
export const blobRelayAssetStore: RelayAssetStore = {
  put: async ({ bytes, mimeType }) =>
    URL.createObjectURL(
      new Blob([bytes as Uint8Array<ArrayBuffer>], mimeType === null ? {} : { type: mimeType }),
    ),
  release: (url) => URL.revokeObjectURL(url),
};

export interface RelayAssetLimits {
  /** One asset; a larger one fails instead of filling memory. */
  readonly maxAssetBytes: number;
  /** Everything kept; the least recently used goes first. */
  readonly maxCacheBytes: number;
  readonly maxEntries: number;
  /** Assets fetched at once over one relay channel, which images share with the RPC socket. */
  readonly maxInFlight: number;
}

export const RELAY_ASSET_LIMITS: RelayAssetLimits = {
  maxAssetBytes: 64 * 1024 * 1024,
  maxCacheBytes: 256 * 1024 * 1024,
  maxEntries: 512,
  maxInFlight: 4,
};

export class RelayAssetFetchError extends Schema.TaggedError<RelayAssetFetchError>()(
  "RelayAssetFetchError",
  {
    reason: Schema.Literals(["unreachable", "status", "too-large", "store"]),
    status: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "too-large":
        return "This file is too large to open through the relay.";
      case "status":
        return `The host answered ${this.status ?? "an error"} for this file.`;
      case "store":
        return "The file could not be kept on this device.";
      case "unreachable":
        return "The file could not be fetched through the relay.";
    }
  }
}

const isRelayAssetFetchError = Schema.is(RelayAssetFetchError);

interface Entry {
  readonly url: string;
  readonly bytes: number;
}

const fileNameOf = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "") || "asset";
  } catch {
    return "asset";
  }
};

/** Reads a body up to `maxBytes`, cancelling it as soon as it is over. */
const readCapped = async (response: Response, maxBytes: number): Promise<Uint8Array | null> => {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const makeRelayAssetCache = (
  store: RelayAssetStore,
  limits: RelayAssetLimits = RELAY_ASSET_LIMITS,
) => {
  // Map order is recency: a hit moves its key to the end.
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<string>>();
  let cachedBytes = 0;
  let running = 0;
  const waiting: Array<() => void> = [];

  const evictFor = (incoming: number) => {
    for (const [key, entry] of entries) {
      if (cachedBytes + incoming <= limits.maxCacheBytes && entries.size < limits.maxEntries) {
        break;
      }
      entries.delete(key);
      cachedBytes -= entry.bytes;
      store.release(entry.url);
    }
  };

  const withSlot = async <A>(run: () => Promise<A>): Promise<A> => {
    if (running >= limits.maxInFlight) await new Promise<void>((resume) => waiting.push(resume));
    running += 1;
    try {
      return await run();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };

  const load = (key: string, url: string, fetch: PreparedConnectionFetch) =>
    withSlot(async () => {
      let response: Response;
      try {
        response = await fetch(url);
      } catch {
        throw new RelayAssetFetchError({ reason: "unreachable" });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new RelayAssetFetchError({ reason: "status", status: response.status });
      }
      let bytes: Uint8Array | null;
      try {
        bytes = await readCapped(response, limits.maxAssetBytes);
      } catch {
        throw new RelayAssetFetchError({ reason: "unreachable" });
      }
      if (bytes === null) throw new RelayAssetFetchError({ reason: "too-large" });
      let local: string;
      try {
        local = await store.put({
          bytes,
          mimeType: response.headers.get("content-type"),
          fileName: fileNameOf(url),
        });
      } catch {
        throw new RelayAssetFetchError({ reason: "store" });
      }
      evictFor(bytes.byteLength);
      entries.set(key, { url: local, bytes: bytes.byteLength });
      cachedBytes += bytes.byteLength;
      return local;
    });

  return {
    /**
     * The local URL for an asset. `key` names the asset across re-mints (the URL's handle changes
     * each time), so the same file is fetched once and keeps its URL while cached.
     */
    resolve: (input: {
      readonly key: string;
      readonly url: string;
      readonly fetch: PreparedConnectionFetch;
    }): Effect.Effect<string, RelayAssetFetchError> =>
      Effect.tryPromise({
        try: () => {
          const cached = entries.get(input.key);
          if (cached !== undefined) {
            entries.delete(input.key);
            entries.set(input.key, cached);
            return Promise.resolve(cached.url);
          }
          const pending = inFlight.get(input.key);
          if (pending !== undefined) return pending;
          const started = load(input.key, input.url, input.fetch).finally(() =>
            inFlight.delete(input.key),
          );
          inFlight.set(input.key, started);
          return started;
        },
        catch: (error) =>
          isRelayAssetFetchError(error)
            ? error
            : new RelayAssetFetchError({ reason: "unreachable" }),
      }),
    /** Forgets an asset, such as one whose file changed. */
    invalidate: (key: string) => {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entries.delete(key);
      cachedBytes -= entry.bytes;
      store.release(entry.url);
    },
    stats: () => ({ entries: entries.size, bytes: cachedBytes, inFlight: running }),
  };
};

export type RelayAssetCache = ReturnType<typeof makeRelayAssetCache>;

type PreparedConnectionFetch = NonNullable<PreparedConnection["transport"]>["fetch"];

/**
 * The URL to load an asset with: as is for a direct connection, a local copy through a relay.
 * `key` names the asset across re-mints; without one, the minted URL is the key.
 */
export const resolveRelayAssetUrl = (
  cache: RelayAssetCache,
  prepared: Pick<PreparedConnection, "httpBaseUrl" | "transport">,
  relativeUrl: string,
  key?: string,
): Effect.Effect<string, RelayAssetFetchError> => {
  const absolute = new URL(relativeUrl, prepared.httpBaseUrl).href;
  return prepared.transport === undefined
    ? Effect.succeed(absolute)
    : cache.resolve({ key: key ?? absolute, url: absolute, fetch: prepared.transport.fetch });
};
