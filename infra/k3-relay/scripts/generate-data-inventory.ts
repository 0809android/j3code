// @effect-diagnostics nodeBuiltinImport:off -- a standalone Node script: it reads the relay schema and writes Markdown.
// @effect-diagnostics globalConsole:off
/**
 * Writes `docs/DATA.md` from the schema in `src/store.ts` (spec section 15, item 4).
 * Run with `--check` to fail when the file is stale. Needs Node 22.18+ and `node:sqlite`.
 * Columns come from the real `SCHEMA_SQL`; only the prose notes below are hand-written.
 */
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { SCHEMA_HASH, SCHEMA_SQL } from "../src/store.ts";

export const DATA_MD_URL = new URL("../docs/DATA.md", import.meta.url);

/**
 * Words that must never appear in a column name (a name is split on `_`). A column for an IP
 * address, a device or project name or an e-mail address would break the promise in
 * TRANSPARENCY.md, so adding one has to be a deliberate edit of this list, in review.
 */
export const FORBIDDEN_COLUMN_WORDS: readonly string[] = [
  "ip",
  "addr",
  "address",
  "remote",
  "name",
  "label",
  "nickname",
  "email",
  "mail",
  "phone",
  "user",
  "username",
  "account",
  "hostname",
  "project",
  "thread",
  "title",
  "agent",
  "ua",
  "content",
  "payload",
  "body",
  "message",
];

interface TableNote {
  readonly purpose: string;
  readonly retention: string;
}

const TABLE_NOTES: Readonly<Record<string, TableNote>> = {
  hosts: {
    purpose: "登録されたホスト（K3 を動かしているマシン）の公開鍵と、日単位の日付だけ。",
    retention:
      "最後に接続した日から 365 日、接続がなければ削除（そのホストの grants、revocations、usage も一緒に消えます）。",
  },
  grants: {
    purpose:
      "ホストが許可した端末（ペアリング済みの端末）の公開鍵と、ホストが署名した許可証（grant）。grant に名前や権限は入れられません。",
    retention:
      "期限から 30 日、その端末が失効されてから 30 日、またはホストが削除されたとき。いちばん早いものが適用されます。",
  },
  revocations: {
    purpose: "ホストが署名した「この端末の許可を取り消す」記録。",
    retention: "30 日。",
  },
  invites: {
    purpose:
      "招待コードのハッシュ。セルフホストで `REQUIRE_INVITE=1` にしたときだけ使われ、公開リレーでは空です。",
    retention: "使用後、または期限後 30 日。",
  },
  usage: {
    purpose: "ホストごとの、月ごとの中継バイト数（公平配分のための数）。通信の中身は含みません。",
    retention: "2 か月（62 日）。",
  },
  blocked_hosts: {
    purpose:
      "運営が遮断したホストの ID と遮断した時刻。悪質なホストの接続を拒否するためだけに使います。",
    retention: "運営が解除するまで。",
  },
};

const COLUMN_NOTES: Readonly<Record<string, string>> = {
  "hosts.host_id": "ホストの ID。公開鍵 `Hk` のハッシュから作る（ホスト名ではありません）",
  "hosts.hk": "ホストの公開鍵（Ed25519）",
  "hosts.registered_day": "登録した日（1970-01-01 からの日数。時刻は持たない）",
  "hosts.last_seen_day": "最後に control 接続した日（日数。時刻は持たない）",
  "grants.host_id": "許可したホストの ID",
  "grants.device_id": "端末の ID。端末の公開鍵 `Dk` のハッシュから作る（端末名ではありません）",
  "grants.dk": "端末の公開鍵",
  "grants.alg": "端末の鍵の種類（`ed25519` または `p256`）",
  "grants.grant_json":
    "ホストが署名した grant。決まった項目（版、hostId、deviceId、alg、発行と期限の時刻、nonce、署名）だけから作り直して保存する",
  "grants.issued_at": "grant の発行時刻（ミリ秒）",
  "grants.expires_at": "grant の期限（ミリ秒）",
  "revocations.host_id": "取り消したホストの ID",
  "revocations.device_id": "取り消された端末の ID",
  "revocations.revoked_at": "取り消しの時刻（ホストが署名した値、ミリ秒）",
  "revocations.sig": "ホストの署名（検証用）",
  "revocations.created_at": "リレーが記録した時刻（ミリ秒。保持期間の起点）",
  "invites.code_hash": "招待コードの SHA-256（コード自体は保存しない）",
  "invites.expires_at": "期限（ミリ秒）",
  "invites.used_at": "使用された時刻（ミリ秒）。未使用なら空",
  "usage.host_id": "ホストの ID",
  "usage.month": "月（`YYYY-MM`）",
  "blocked_hosts.host_id": "遮断したホストの ID",
  "blocked_hosts.blocked_at": "遮断した時刻（ミリ秒）",
  "usage.bytes": "その月に中継した合計バイト数（両方向、1 バイトにつき 1 回）",
};

/** What the relay never writes to disk (spec section 10). Fixed text, not derived from the schema. */
const NEVER_STORED: readonly (readonly [string, string])[] = [
  [
    "IP アドレス",
    "接続元の IP は、リレーの DB にも、リレーのログにも書きません。上限の判断に使う回数は、メモリにだけ置きます。手前の Caddy のエラーログには、TLS の失敗などで接続元が出ることがあります（TRANSPARENCY.md）。",
  ],
  [
    "通信内容",
    "ホストと端末の間のデータは E2E で暗号化されていて、リレーは暗号文を渡すだけです。中身を解釈も保存もしません。",
  ],
  [
    "通知の中身",
    "通知（P4）を足すときも、リレーは暗号文を APNs / FCM に渡すだけで、保存しません。",
  ],
  ["端末名", "grant には名前の欄がなく、名前の付いた grant は受け取りません。"],
  ["ホスト名", "ホストは、公開鍵のハッシュ（hostId）としてだけ見えます。"],
  ["プロジェクト名、スレッド名", "これらは E2E の中にだけ存在し、リレーには届きません。"],
  ["アカウント、メールアドレス、氏名", "リレーは、人（ユーザー）と端末の対応を持ちません。"],
];

const IN_MEMORY_ONLY: readonly string[] = [
  "nonce（認証の使い捨ての値）",
  "セッション",
  "データ接続の token",
  "ペアリングの窓",
  "IP ごとの接続や登録の回数（上限の判断のため。再起動で消えます）",
  "指標（接続数、帯域、切断の理由の内訳など）",
];

export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
}

export interface TableInfo {
  readonly name: string;
  readonly columns: readonly ColumnInfo[];
}

/** Applies the real schema to an in-memory database and reads the result back. */
export function readSchema(sql: string = SCHEMA_SQL): readonly TableInfo[] {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    db.exec(sql);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
      )
      .all() as { name: string }[];
    return tables.map(({ name }) => {
      const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all() as {
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }[];
      return {
        name,
        columns: columns.map((column) => ({
          name: column.name,
          type: column.type,
          notNull: column.notnull === 1,
          primaryKey: column.pk > 0,
        })),
      };
    });
  } finally {
    db.close();
  }
}

/** Column names that contain a forbidden word, as `table.column`. */
export function findForbiddenColumns(tables: readonly TableInfo[]): string[] {
  const forbidden = new Set(FORBIDDEN_COLUMN_WORDS);
  return tables.flatMap((table) =>
    table.columns
      .filter((column) =>
        column.name
          .toLowerCase()
          .split("_")
          .some((word) => forbidden.has(word)),
      )
      .map((column) => `${table.name}.${column.name}`),
  );
}

function assertDocumented(tables: readonly TableInfo[]): void {
  const problems: string[] = [];
  const tableNames = new Set(tables.map((table) => table.name));
  const columnNames = new Set(
    tables.flatMap((table) => table.columns.map((column) => `${table.name}.${column.name}`)),
  );
  for (const name of tableNames) {
    if (!(name in TABLE_NOTES)) problems.push(`table ${name}: add it to TABLE_NOTES`);
  }
  for (const name of Object.keys(TABLE_NOTES)) {
    if (!tableNames.has(name)) problems.push(`TABLE_NOTES has ${name}, but the schema does not`);
  }
  for (const name of columnNames) {
    if (!(name in COLUMN_NOTES)) problems.push(`column ${name}: add it to COLUMN_NOTES`);
  }
  for (const name of Object.keys(COLUMN_NOTES)) {
    if (!columnNames.has(name)) problems.push(`COLUMN_NOTES has ${name}, but the schema does not`);
  }
  if (problems.length > 0) {
    throw new Error(`docs/DATA.md cannot be generated:\n- ${problems.join("\n- ")}`);
  }
}

export function renderDataMarkdown(
  tables: readonly TableInfo[] = readSchema(),
  schemaHash: string = SCHEMA_HASH,
): string {
  assertDocumented(tables);
  const lines: string[] = [
    "<!-- このファイルは自動生成です。直接は編集しないでください。",
    "     再生成: node infra/k3-relay/scripts/generate-data-inventory.ts",
    "     元: infra/k3-relay/src/store.ts の SCHEMA_SQL。CI が、このファイルと生成結果の一致を検査します。 -->",
    "",
    "# K3 Relay が保存するデータ",
    "",
    "リレーが DB（SQLite）に書くものの、全部の一覧です。表と列は、`src/store.ts` のスキーマから自動で作っています。説明と保持期間は `scripts/generate-data-inventory.ts` に書いてあり、スキーマと食い違うと CI が失敗します。",
    "",
    `動いているリレーの \`/.well-known/k3-relay\` が返す \`schemaHash\` は、次の値と同じになります（同じスキーマで動いていることの目安）。`,
    "",
    `\`${schemaHash}\``,
    "",
    "## 保存するもの",
    "",
  ];
  for (const table of tables) {
    const note = TABLE_NOTES[table.name]!;
    lines.push(
      `### \`${table.name}\``,
      "",
      note.purpose,
      "",
      `保持: ${note.retention}`,
      "",
      "列:",
      "",
    );
    for (const column of table.columns) {
      const traits = [
        column.type,
        column.primaryKey ? "主キー" : column.notNull ? "必須" : "省略可",
      ];
      lines.push(
        `- \`${column.name}\`（${traits.join("、")}）: ${COLUMN_NOTES[`${table.name}.${column.name}`]!}`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## 保存しないもの",
    "",
    "リレーは、次のものを DB にも、ログにも、書きません。",
    "",
    ...NEVER_STORED.map(([item, how]) => `- **${item}**: ${how}`),
    "",
    "## メモリにだけ置くもの",
    "",
    "再起動で消えます。",
    "",
    ...IN_MEMORY_ONLY.map((item) => `- ${item}`),
    "",
    "## 列名の検査",
    "",
    `スキーマの列名に、次の語（\`_\` で区切った単語）を含むものがあると、テストが失敗します。${FORBIDDEN_COLUMN_WORDS.map((word) => `\`${word}\``).join("、")}。個人や接続元を特定できる列を、うっかり足さないための歯止めです。`,
    "",
  );
  return lines.join("\n");
}

function main(): void {
  const generated = renderDataMarkdown();
  if (process.argv.includes("--check")) {
    const committed = NodeFS.existsSync(DATA_MD_URL)
      ? NodeFS.readFileSync(DATA_MD_URL, "utf8")
      : "";
    if (committed !== generated) {
      console.error(
        "infra/k3-relay/docs/DATA.md is out of date with the schema in src/store.ts.\n" +
          "Run: node infra/k3-relay/scripts/generate-data-inventory.ts   (then commit docs/DATA.md)",
      );
      process.exit(1);
    }
    console.log("docs/DATA.md matches the schema.");
    return;
  }
  NodeFS.mkdirSync(new URL("./", DATA_MD_URL), { recursive: true });
  NodeFS.writeFileSync(DATA_MD_URL, generated);
  console.log("wrote infra/k3-relay/docs/DATA.md");
}

if (import.meta.main) main();
