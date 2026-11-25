import { makeRelayAssetCache, type RelayAssetStore } from "@t3tools/client-runtime/k3relay";
import { Directory, File, Paths } from "expo-file-system";

import { uuidv4 } from "./uuid";

/**
 * Assets of hosts behind a K3 relay, kept as cache files: React Native cannot make a Blob from
 * bytes, and `<Image>` and the video player load `file://` URIs. The folder is emptied at start,
 * since the cache that named its files is gone with the last run.
 */
const RELAY_ASSET_DIRECTORY = "k3relay-assets";

let directory: Directory | null = null;

const assetDirectory = () => {
  if (directory !== null) return directory;
  const next = new Directory(Paths.cache, RELAY_ASSET_DIRECTORY);
  if (next.exists) next.delete();
  next.create({ idempotent: true, intermediates: true });
  directory = next;
  return next;
};

const safeFileName = (name: string) => name.replace(/[^\w.-]+/gu, "_").slice(-80) || "asset";

const relayAssetFileStore: RelayAssetStore = {
  put: async ({ bytes, fileName }) => {
    const file = new File(assetDirectory(), `${uuidv4()}-${safeFileName(fileName)}`);
    file.create();
    file.write(bytes);
    return file.uri;
  },
  release: (uri) => {
    try {
      new File(uri).delete();
    } catch {
      // Already gone: the OS may clear the cache folder.
    }
  },
};

export const relayAssets = makeRelayAssetCache(relayAssetFileStore);
