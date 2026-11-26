import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const read = (name: string) => NodeFS.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("deployment files", () => {
  const caddyfile = read("Caddyfile");
  const directives = caddyfile
    .split("\n")
    .map((line) => line.replace(/#.*/u, "").trim())
    .filter((line) => line !== "");

  it("never turns on an access log, and keeps the global log to errors", () => {
    const logLines = directives.filter((line) => /^log\b/u.test(line));
    expect(logLines).toEqual(["log {"]);
    const globalBlock = caddyfile.slice(0, caddyfile.indexOf("{$RELAY_DOMAIN"));
    expect(globalBlock).toContain("level ERROR");
    expect(directives).not.toContain("output file");
  });

  it("hides /metrics, replaces the forwarded address, and caps request bodies", () => {
    expect(directives).toContain("respond @metrics 404");
    expect(directives).toContain("header_up X-Forwarded-For {remote_host}");
    expect(directives).toContain("max_size 16KB");
  });

  it("builds a small non-root image from the sources only", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toMatch(/^USER node$/mu);
    expect(dockerfile).not.toMatch(/COPY \. /u);
    expect(dockerfile).toContain("ws@8.22.0");
  });

  it("keeps the relay unpublished, behind Caddy, with a memory limit", () => {
    const compose = read("docker-compose.example.yml");
    expect(compose).not.toMatch(/- "8080:8080"/u);
    expect(compose).toContain('TRUST_PROXY: "1"');
    expect(compose).toContain("mem_limit: 400m");
  });
});
