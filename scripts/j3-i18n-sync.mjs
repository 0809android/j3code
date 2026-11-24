#!/usr/bin/env node
// J3 Code 独自の翻訳オーバーレイを管理・再注入するユーティリティ。
//
// 使い方:
//   node scripts/j3-i18n-sync.mjs            # gt generate を実行し、J3 独自訳を全ロケールへ再適用してフォーマットする
//   node scripts/j3-i18n-sync.mjs --capture  # upstream/main との差分から J3 独自訳を抽出し scripts/j3-i18n-overrides.json を更新する

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const OVERRIDES_PATH = NodePath.join(ROOT, "scripts", "j3-i18n-overrides.json");

const APPS = {
  "apps/web": [process.execPath, "node_modules/gt/bin/main.js", "generate"],
  "apps/mobile": [process.execPath, "node_modules/gt/bin/main.js", "generate"],
  "apps/desktop": [process.execPath, "scripts/i18n-generate.mjs"],
};

function readJson(filePath) {
  return JSON.parse(NodeFS.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  NodeFS.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function assertGitRefExists(ref) {
  const verify = NodeChildProcess.spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  if (verify.status !== 0) {
    console.error(
      `Base git ref "${ref}" was not found. Run \`git fetch upstream\` or pass \`--base <ref>\` before capturing overrides.`,
    );
    process.exit(1);
  }
}

function readGitJson(ref, repoRelativePath) {
  const normalized = repoRelativePath.split(NodePath.sep).join("/");
  const exists = NodeChildProcess.spawnSync("git", ["cat-file", "-e", `${ref}:${normalized}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (exists.status !== 0) {
    return null;
  }
  const result = NodeChildProcess.spawnSync("git", ["show", `${ref}:${normalized}`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.error(`Failed to read ${ref}:${normalized}:\n${result.stderr}`);
    process.exit(1);
  }
  return JSON.parse(result.stdout);
}

function getAppCatalogInfo(app) {
  const appDir = NodePath.join(ROOT, app);
  const config = readJson(NodePath.join(appDir, "gt.config.json"));
  const catalogDir = NodePath.join(appDir, NodePath.dirname(config.files.gt.output));
  return {
    appDir,
    defaultLocale: config.defaultLocale,
    locales: config.locales,
    catalogDir,
  };
}

function formatFiles(filePaths) {
  if (filePaths.length === 0) return;
  const vpCmd = NodePath.join(ROOT, "node_modules", ".bin", "vp.cmd");
  const vpPosix = NodePath.join(ROOT, "node_modules", ".bin", "vp");
  const useCmd = NodePath.sep === "\\" && NodeFS.existsSync(vpCmd);
  const vpBin = useCmd ? vpCmd : vpPosix;
  if (!NodeFS.existsSync(vpBin)) return;
  const result = useCmd
    ? NodeChildProcess.spawnSync("cmd.exe", ["/c", vpBin, "fmt", ...filePaths], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: "pipe",
      })
    : NodeChildProcess.spawnSync(vpBin, ["fmt", ...filePaths], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: "pipe",
      });
  if (result.status !== 0) {
    console.error(`vp fmt failed:\n${result.stdout}\n${result.stderr}`);
    process.exit(1);
  }
}

function captureOverrides(baseRef) {
  assertGitRefExists(baseRef);
  const overrides = {};
  let totalKeys = 0;

  for (const app of Object.keys(APPS)) {
    const info = getAppCatalogInfo(app);
    const appOverrides = {};

    for (const locale of info.locales) {
      const currentPath = NodePath.join(info.catalogDir, `${locale}.json`);
      const repoRelPath = NodePath.relative(ROOT, currentPath);
      const currentCatalog = readJson(currentPath);
      const upstreamCatalog = readGitJson(baseRef, repoRelPath) ?? {};
      const localeOverrides = {};

      for (const [key, value] of Object.entries(currentCatalog)) {
        if (
          !Object.hasOwn(upstreamCatalog, key) ||
          JSON.stringify(upstreamCatalog[key]) !== JSON.stringify(value)
        ) {
          localeOverrides[key] = value;
          totalKeys += 1;
        }
      }

      if (Object.keys(localeOverrides).length > 0) {
        appOverrides[locale] = localeOverrides;
      }
    }

    overrides[app] = appOverrides;
  }

  writeJson(OVERRIDES_PATH, overrides);
  formatFiles([OVERRIDES_PATH]);
  console.log(
    `Captured J3 i18n overrides from ${baseRef} -> ${NodePath.relative(ROOT, OVERRIDES_PATH)} (${totalKeys} entries).`,
  );
}

function syncCatalogs(skipGenerate, skipFmt) {
  const overrides = NodeFS.existsSync(OVERRIDES_PATH) ? readJson(OVERRIDES_PATH) : {};
  const missingReport = [];
  const writtenFiles = [];

  for (const [app, [command, ...args]] of Object.entries(APPS)) {
    const info = getAppCatalogInfo(app);

    if (!skipGenerate) {
      console.log(`[${app}] Running gt generate...`);
      const generated = NodeChildProcess.spawnSync(command, args, {
        cwd: info.appDir,
        encoding: "utf8",
        stdio: "pipe",
      });
      if (generated.status !== 0) {
        console.error(`[${app}] gt generate failed:\n${generated.stdout}\n${generated.stderr}`);
        process.exit(1);
      }
    }

    const sourcePath = NodePath.join(info.catalogDir, `${info.defaultLocale}.json`);
    const sourceCatalog = readJson(sourcePath);
    const sourceKeys = Object.keys(sourceCatalog);
    const appOverrides = overrides[app] ?? {};
    writtenFiles.push(sourcePath);

    for (const locale of info.locales) {
      const localePath = NodePath.join(info.catalogDir, `${locale}.json`);
      const existing = NodeFS.existsSync(localePath) ? readJson(localePath) : {};
      const localeOverrides = appOverrides[locale] ?? {};
      const nextCatalog = {};
      let appliedCount = 0;

      for (const key of sourceKeys) {
        if (Object.hasOwn(localeOverrides, key)) {
          nextCatalog[key] = localeOverrides[key];
          appliedCount += 1;
        } else if (Object.hasOwn(existing, key)) {
          nextCatalog[key] = existing[key];
        } else {
          missingReport.push(`${app} [${locale}]: ${key} ${JSON.stringify(sourceCatalog[key])}`);
        }
      }

      writeJson(localePath, nextCatalog);
      writtenFiles.push(localePath);
      console.log(
        `[${app}] synced ${locale}.json (${sourceKeys.length} keys, ${appliedCount} J3 overrides applied)`,
      );
    }
  }

  if (!skipFmt) {
    formatFiles(writtenFiles);
  }

  if (missingReport.length > 0) {
    console.error("\nMissing translations detected:");
    console.error(missingReport.join("\n"));
    console.error(
      "\nAdd translations to the locale catalogs, then run `vp run j3:i18n:capture` to save them into scripts/j3-i18n-overrides.json.",
    );
    process.exit(1);
  }

  console.log("\nAll J3 i18n catalogs synced successfully.");
}

const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--capture")) {
  const baseIdx = cliArgs.indexOf("--base");
  const baseRef = baseIdx >= 0 && cliArgs[baseIdx + 1] ? cliArgs[baseIdx + 1] : "upstream/main";
  captureOverrides(baseRef);
} else {
  const skipGenerate = cliArgs.includes("--no-generate");
  const skipFmt = cliArgs.includes("--no-fmt");
  syncCatalogs(skipGenerate, skipFmt);
}
