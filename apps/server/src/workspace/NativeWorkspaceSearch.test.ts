// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  checkIgnoredPathsNative,
  grepWorkspaceContentsNative,
  searchWorkspaceFilesNative,
} from "./NativeWorkspaceSearch.ts";

describe("NativeWorkspaceSearch (Rust sidecar)", () => {
  it("searches files and greps contents when the binary is built", async () => {
    const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j3-native-ws-"));
    try {
      await NodeFSP.mkdir(NodePath.join(tempDir, ".git"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(tempDir, "src"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(tempDir, ".gitignore"), "secret.log\n", "utf8");
      await NodeFSP.writeFile(NodePath.join(tempDir, "secret.log"), "J3_TOKEN_NEEDLE\n", "utf8");
      await NodeFSP.writeFile(
        NodePath.join(tempDir, "src", "provider.ts"),
        'export const title = "J3_TOKEN_NEEDLE";\n',
        "utf8",
      );

      const files = await searchWorkspaceFilesNative({
        cwd: tempDir,
        query: "provider",
        limit: 10,
      });
      if (files === null) {
        return;
      }

      expect(files.entries.map((entry) => entry.path)).toContain("src/provider.ts");
      expect(files.entries.map((entry) => entry.path)).not.toContain("secret.log");

      const grep = await grepWorkspaceContentsNative({
        cwd: tempDir,
        query: "J3_TOKEN_NEEDLE",
        limit: 10,
      });
      expect(grep).not.toBeNull();
      expect(grep!.error).toBeUndefined();
      expect(grep!.matches.length).toBe(1);
      expect(grep!.matches[0]!.path).toBe("src/provider.ts");
      expect(grep!.matches[0]!.line).toBe(1);

      const check = await checkIgnoredPathsNative({
        cwd: tempDir,
        paths: [
          { path: "secret.log", isDir: false },
          { path: "src/provider.ts", isDir: false },
        ],
      });
      expect(check).not.toBeNull();
      expect(check!.ok).toBe(true);
      expect(check!.ignored).toEqual(["secret.log"]);
    } finally {
      await NodeFSP.rm(tempDir, { recursive: true, force: true });
    }
  });
});
