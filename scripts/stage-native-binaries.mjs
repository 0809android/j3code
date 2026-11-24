// Stages compiled J3 Code Rust sidecar binaries into apps/desktop/prod-resources/j3-native
// so Electron desktop builds automatically bundle them via extraResources.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const outDir = NodePath.join(repoRoot, "apps", "desktop", "prod-resources", "j3-native");
const isWin = NodePath.sep === "\\";
const ext = isWin ? ".exe" : "";

function resolveCargoTargetDir(manifestPath) {
  try {
    const raw = NodeChildProcess.execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", manifestPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const parsed = JSON.parse(raw);
    return typeof parsed.target_directory === "string" ? parsed.target_directory : null;
  } catch {
    return null;
  }
}

const binaries = [
  { crate: "j3-usage-scanner", name: `j3-usage-scanner${ext}` },
  { crate: "j3-workspace-search", name: `j3-workspace-search${ext}` },
  { crate: "j3-relay-proxy", name: `j3-relay-proxy${ext}` },
];

NodeFS.mkdirSync(outDir, { recursive: true });

const envTargetDir = process.env.CARGO_TARGET_DIR?.trim();
let staged = 0;

for (const { crate, name } of binaries) {
  const manifestPath = NodePath.join(repoRoot, "native", crate, "Cargo.toml");
  const cargoMetaTargetDir = resolveCargoTargetDir(manifestPath);
  const candidates = [
    ...(cargoMetaTargetDir ? [NodePath.join(cargoMetaTargetDir, "release", name)] : []),
    ...(envTargetDir ? [NodePath.join(envTargetDir, "release", name)] : []),
    NodePath.join(repoRoot, "native", crate, "target", "release", name),
  ];
  const src = candidates.find((candidate) => {
    try {
      return NodeFS.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!src) {
    console.warn(`[stage-native] skipped ${name} (not built yet)`);
    continue;
  }
  const dest = NodePath.join(outDir, name);
  NodeFS.copyFileSync(src, dest);
  if (!isWin) {
    NodeFS.chmodSync(dest, 0o755);
  }
  staged += 1;
  console.log(`[stage-native] staged ${name} -> ${NodePath.relative(repoRoot, dest)}`);
}

if (staged === 0) {
  console.warn("[stage-native] no compiled binaries found. Run `vp run build:native` first.");
}
