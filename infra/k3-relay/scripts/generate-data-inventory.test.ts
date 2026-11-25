// @effect-diagnostics nodeBuiltinImport:off -- reads the committed docs/DATA.md.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { SCHEMA_SQL } from "../src/store.ts";
import {
  DATA_MD_URL,
  FORBIDDEN_COLUMN_WORDS,
  findForbiddenColumns,
  readSchema,
  renderDataMarkdown,
} from "./generate-data-inventory.ts";

describe("data inventory", () => {
  it("matches the committed docs/DATA.md (regenerate with scripts/generate-data-inventory.ts)", () => {
    expect(NodeFS.readFileSync(DATA_MD_URL, "utf8")).toBe(renderDataMarkdown());
  });

  it("lists every table and column of the real schema", () => {
    const tables = readSchema();
    expect(tables.map((table) => table.name)).toEqual([
      "hosts",
      "grants",
      "revocations",
      "invites",
      "usage",
    ]);
    const markdown = renderDataMarkdown();
    for (const table of tables) {
      expect(markdown).toContain(`### \`${table.name}\``);
      for (const column of table.columns) expect(markdown).toContain(`- \`${column.name}\`（`);
    }
  });

  it("states what is never stored", () => {
    const markdown = renderDataMarkdown();
    expect(markdown).toContain("## 保存しないもの");
    for (const item of ["IP アドレス", "通信内容", "端末名", "プロジェクト名、スレッド名"]) {
      expect(markdown).toContain(item);
    }
  });

  it("refuses to generate when a table or column has no description", () => {
    const undocumented = `${SCHEMA_SQL}\nCREATE TABLE extra (id TEXT PRIMARY KEY) STRICT;`;
    expect(() => renderDataMarkdown(readSchema(undocumented))).toThrow(/extra/u);
    const extraColumn = SCHEMA_SQL.replace(
      "bytes INTEGER NOT NULL,",
      "bytes INTEGER NOT NULL, note TEXT,",
    );
    expect(() => renderDataMarkdown(readSchema(extraColumn))).toThrow(/usage\.note/u);
  });
});

describe("schema has no identifying column", () => {
  it("has no column whose name suggests an IP, a name, a label or an e-mail address", () => {
    expect(findForbiddenColumns(readSchema())).toEqual([]);
  });

  it("catches the column names the spec rules out", () => {
    const bad = [
      "ip",
      "client_ip",
      "remote_address",
      "address",
      "device_name",
      "host_name",
      "name",
      "label",
      "email",
      "project_name",
      "thread_title",
    ];
    const tables = readSchema(
      `CREATE TABLE t (${bad.map((column) => `${column} TEXT`).join(", ")}) STRICT;`,
    );
    expect(findForbiddenColumns(tables)).toEqual(bad.map((column) => `t.${column}`));
  });

  it("keeps the words that spec section 10 names in the forbidden list", () => {
    for (const word of ["ip", "address", "name", "label", "email"]) {
      expect(FORBIDDEN_COLUMN_WORDS).toContain(word);
    }
  });

  it("does not let the stored grant carry a name or permission field", () => {
    const grants = readSchema().find((table) => table.name === "grants");
    expect(grants?.columns.map((column) => column.name)).toEqual([
      "host_id",
      "device_id",
      "dk",
      "alg",
      "grant_json",
      "issued_at",
      "expires_at",
    ]);
  });
});
