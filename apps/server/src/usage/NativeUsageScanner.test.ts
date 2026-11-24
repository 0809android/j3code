// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { filterTranscriptLinesNative, listTranscriptFilesNative } from "./NativeUsageScanner.ts";
import { listTranscriptFiles } from "./usageTranscriptReader.ts";

describe("NativeUsageScanner (Rust sidecar)", () => {
  it("lists and filters transcript files identically to the TypeScript fallback", async () => {
    const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j3-native-usage-"));
    try {
      const subDir = NodePath.join(tempDir, "nested");
      await NodeFSP.mkdir(subDir, { recursive: true });
      const filePath = NodePath.join(subDir, "session.jsonl");
      await NodeFSP.writeFile(
        filePath,
        ['{"type":"noise"}', '{"type":"usage","tokens":42}', '{"type":"usage","tokens":99}'].join(
          "\n",
        ),
        "utf8",
      );

      const nativeList = await listTranscriptFilesNative(tempDir, 0);
      if (nativeList === null) {
        // Binary not built in this environment; verify graceful null fallback.
        return;
      }

      expect(nativeList.failedPaths).toBe(0);
      expect(nativeList.files.length).toBe(1);
      expect(nativeList.files[0]!.path).toBe(filePath);

      process.env.J3CODE_DISABLE_NATIVE_ACCELERATORS = "1";
      const tsList = await listTranscriptFiles(tempDir, 0);
      delete process.env.J3CODE_DISABLE_NATIVE_ACCELERATORS;
      expect(tsList.files.map((f) => f.path)).toEqual(nativeList.files.map((f) => f.path));

      const filtered = await filterTranscriptLinesNative({
        path: filePath,
        markers: ['"usage"'],
      });
      expect(filtered).not.toBeNull();
      expect(filtered!.ok).toBe(true);
      expect(filtered!.matchedLines).toEqual(['{"type":"usage","tokens":42}']);
      expect(filtered!.tailLine).toBe('{"type":"usage","tokens":99}');
    } finally {
      delete process.env.J3CODE_DISABLE_NATIVE_ACCELERATORS;
      await NodeFSP.rm(tempDir, { recursive: true, force: true });
    }
  });
});
