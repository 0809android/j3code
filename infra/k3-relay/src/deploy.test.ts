import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const path = (name: string) => new URL(`../deploy/${name}`, import.meta.url);
const read = (name: string) => NodeFS.readFileSync(path(name), "utf8");

/** Shell source without comment lines, with backslash continuations joined. */
const commands = (name: string) =>
  read(name)
    .replace(/\\\n\s*/gu, " ")
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line));

const SCRIPTS = [
  "backup.sh",
  "compose.sh",
  "healthcheck.sh",
  "install.sh",
  "notify.sh",
  "oci-provision.sh",
];

describe("deploy scripts", () => {
  it("are executable bash scripts that stop on errors", () => {
    for (const name of SCRIPTS) {
      const source = read(name);
      expect(source.startsWith("#!/usr/bin/env bash\n"), name).toBe(true);
      expect(source, name).toMatch(/^set -[euo]+ pipefail$/mu);
      expect(NodeFS.statSync(path(name)).mode & 0o111, `${name} is executable`).not.toBe(0);
    }
  });

  it("never print the alarm webhook URL, and send it over https only", () => {
    const lines = commands("notify.sh").join("\n");
    expect(lines).toContain("--proto '=https'");
    expect(lines).not.toMatch(/(echo|printf)[^\n]*\$\{?url\}?/u);
    expect(lines).not.toMatch(/set -x/u);
  });
});

describe("oci-provision.sh", () => {
  const lines = commands("oci-provision.sh");
  const source = lines.join("\n");

  it("is a dry run unless --apply is given", () => {
    expect(source).toMatch(/^apply=0$/mu);
    expect(source).toContain("--apply) apply=1");
    expect(source).toContain("--dry-run) apply=0");
    expect(source).toMatch(/if \[ "\$apply" = 1 \]; then\n\s+oci "\$\{OCI_GLOBAL\[@\]\}" "\$@"/u);
  });

  it("calls the oci CLI only through its read and write helpers", () => {
    const direct = lines.filter((line) => /\boci "\$\{OCI_GLOBAL\[@\]\}"/u.test(line));
    expect(direct).toHaveLength(2);
    for (const line of lines.filter((candidate) => candidate.includes("oci_read"))) {
      expect(line, "a read helper call changes something").not.toMatch(
        /\b(create|launch|update|delete|terminate|remove)\b/u,
      );
    }
    for (const line of lines.filter((candidate) => /\b(create|launch)\b/u.test(candidate))) {
      if (/^\s*(launch_args=|--)/u.test(line)) continue;
      if (!/\b(iam|network|compute|os)\b/u.test(line)) continue;
      expect(line, "creating without the write helper").toMatch(/oci_write|launch_args/u);
    }
  });

  it("deletes, terminates and changes nothing that exists, and makes no DNS record or IAM rule", () => {
    expect(source).not.toMatch(
      /\b(delete|terminate|remove|update|change-compartment|bulk-delete)\b|--force/u,
    );
    expect(source).not.toMatch(/\bdns\b.*\b(create|record)\b|dynamic-group create|policy create/u);
  });

  it("checks the free micro allowance before it launches, and says what is left", () => {
    const check = source.indexOf("always-free micro instances");
    const launch = source.indexOf("compute instance launch");
    expect(check).toBeGreaterThan(0);
    expect(launch).toBeGreaterThan(check);
    expect(source).toContain("FREE_MICRO_LIMIT=2");
    expect(source).toContain("SHAPE=VM.Standard.E2.1.Micro");
    expect(source).toContain("home region");
  });

  it("refuses an SSH range that is open to everyone, and stops when the instance exists", () => {
    expect(source).toContain('[ "$ssh_cidr" != "0.0.0.0/0" ]');
    expect(source).toContain("Not touching it.");
  });

  it("fills exactly the placeholders the cloud-init template has", () => {
    const template = new Set(
      [...read("cloud-init.yaml").matchAll(/@@([A-Z0-9_]+)@@/gu)].map((match) => match[1]),
    );
    const listed = /split\("([A-Z0-9_ ]+)", keys/u.exec(read("oci-provision.sh"))?.[1] ?? "";
    expect(new Set(listed.split(" "))).toEqual(template);
  });
});

describe("cloud-init.yaml", () => {
  const template = read("cloud-init.yaml");

  it("opens 80 and 443 to everyone and 22 only through the SSH range placeholder", () => {
    const rules = template.split("\n").filter((line) => line.includes("-A INPUT"));
    expect(rules.some((line) => line.includes("--dport 80 "))).toBe(true);
    expect(rules.some((line) => line.includes("--dport 443 "))).toBe(true);
    expect(rules.filter((line) => line.includes("--dport 22"))).toEqual([]);
    expect(template).toContain("@@SSH_RULE_V4@@");
    expect(template).toContain(":INPUT DROP");
  });

  it("sets up swap, security updates, Docker, the backup timer and a user", () => {
    expect(template).toContain("size: 1073741824");
    expect(template).toContain("unattended-upgrades");
    expect(template).toContain("docker.io");
    expect(template).toContain("docker-compose-v2");
    expect(template).toContain("k3-relay-bootstrap");
    expect(template).toContain("name: k3");
    expect(template).toContain("BACKUP_KEEP=14");
    expect(template).toContain("OCI_CLI_AUTH=instance_principal");
  });

  it("fetches one pinned commit and nothing but the relay's directory", () => {
    expect(template).toContain("sparse-checkout set --cone infra/k3-relay");
    expect(template).toContain("--depth 1");
  });
});

describe("backup and systemd units", () => {
  it("keeps 14 generations by default and only deletes names it makes itself", () => {
    const backup = read("backup.sh");
    expect(backup).toContain("BACKUP_KEEP:-14");
    expect(backup).toContain("oci os object put");
    expect(backup).toContain("oci os object delete");
    expect(backup).toContain("relay-[0-9]{8}T[0-9]{6}Z");
    expect(backup).toContain("--dry-run");
    expect(backup).toContain("node src/cli.ts backup");
    // The prune comes after the upload.
    expect(backup.indexOf("oci os object delete")).toBeGreaterThan(
      backup.indexOf("oci os object put"),
    );
  });

  it("runs the backup every night, and catches up after a missed one", () => {
    const timer = read("systemd/k3-relay-backup.timer");
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* 18:30:00 UTC$/mu);
    expect(timer).toContain("Persistent=true");
    const service = read("systemd/k3-relay-backup.service");
    expect(service).toContain("ExecStart=@@RELAY_DIR@@/deploy/backup.sh");
    expect(service).toContain("EnvironmentFile=/etc/k3-relay/backup.env");
    expect(read("install.sh")).toContain("@@RELAY_DIR@@");
  });

  it("gives the container a place to write snapshots, from outside the read-only root", () => {
    const compose = read("docker-compose.oci.yml");
    expect(compose).toContain("/var/lib/k3-relay/backup:/backup");
    expect(compose).toContain("RELAY_IMAGE");
    expect(read("install.sh")).toContain("/var/lib/k3-relay/backup");
  });
});

describe("healthcheck.sh", () => {
  it("alerts after three failures in a row, once, and again when the relay is back", () => {
    const script = read("healthcheck.sh");
    expect(script).toContain("K3_HEALTH_FAILS:-3");
    expect(script).toContain(`'{"ok":true}'`);
    expect(script).toContain("health check failing");
    expect(script).toContain("health check recovered");
  });
});
