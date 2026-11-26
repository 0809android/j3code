// @effect-diagnostics nodeBuiltinImport:off -- reads the workflow files.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const read = (path: string) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");
const build = read("../../../.github/workflows/k3-relay-build.yml");
const deploy = read("../../../.github/workflows/k3-relay-deploy.yml");

const usesLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(- )?uses:/u.test(line))
    .map((line) => line.replace(/^- /u, ""));

describe("k3-relay workflows", () => {
  it("pins every third-party action to a commit SHA", () => {
    for (const line of [...usesLines(build), ...usesLines(deploy)]) {
      if (line.startsWith("uses: ./")) continue;
      expect(line, line).toMatch(/^uses: [\w./-]+@[0-9a-f]{40} # v\d/u);
    }
  });

  it("deploys only on a manual dispatch, into the protected environment", () => {
    const trigger = deploy.slice(deploy.indexOf("\non:"), deploy.indexOf("\npermissions:"));
    expect(trigger).toContain("workflow_dispatch:");
    expect(trigger).not.toMatch(/^ {2}(push|pull_request|schedule|workflow_run)\b/mu);
    expect(deploy).toMatch(/environment:\n\s+name: k3-relay-prod/u);
  });

  it("checks the live relay against the deployed digest and commit", () => {
    expect(deploy).toContain("verify-live.sh");
    expect(deploy).toContain("gh attestation verify");
  });

  it("never writes a secret value into the deploy workflow", () => {
    expect(deploy).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/u);
    expect(deploy).not.toMatch(/\bssh-(ed25519|rsa) AAAA/u);
    for (const name of ["SSH_KEY", "SSH_KNOWN_HOSTS", "SSH_HOST", "SSH_USER"]) {
      expect(deploy).toContain(`secrets.K3_RELAY_${name}`);
    }
  });

  it("pushes and attests only for push events, never for pull requests", () => {
    expect(build).toMatch(/if \[ "\$EVENT_NAME" = "push" \]; then\n\s+push=true/u);
    expect(build).toContain("push: ${{ steps.plan.outputs.push == 'true' }}");
    expect(build).toMatch(/Attest the build provenance\n\s+if: steps.plan.outputs.push == 'true'/u);
    expect(build).toContain("actions/attest-build-provenance@");
    expect(build).toContain("ghcr.io/kinocode-jp/k3-relay");
    // Fork pull requests must not reach the self-hosted runner.
    expect(build).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });
});
