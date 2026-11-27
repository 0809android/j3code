import * as NodeWorkerThreads from "node:worker_threads";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class SqliteSnapshotError extends Schema.TaggedError<SqliteSnapshotError>()(
  "SqliteSnapshotError",
  { sourcePath: Schema.String, snapshotPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not copy the database at ${this.sourcePath} to ${this.snapshotPath}.`;
  }
}

// 古いファイルは auto_vacuum がなく、ページ単位のバックアップではそれが残る。VACUUM INTO は
// コピーを詰めて incremental を有効にし、サーバーが空きページを返せるようにする。読み取り専用で
// すでに設定済みのファイルに設定するとエラーになるので、未設定のときだけ設定する。数 GB の
// コピーで全接続が止まらないよう、別スレッドで実行する。
const snapshotWorkerSource = `
const { workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(workerData.sourcePath, { readOnly: true });
try {
  if (database.prepare("PRAGMA auto_vacuum").get().auto_vacuum === 0) {
    database.exec("PRAGMA auto_vacuum = INCREMENTAL");
  }
  database.prepare("VACUUM INTO ?").run(workerData.snapshotPath);
} finally {
  database.close();
}
`;

/** `sourcePath` を詰めたコピーを `snapshotPath` に書く。`snapshotPath` はまだ存在してはいけない。 */
export const snapshotSqliteDatabase = (sourcePath: string, snapshotPath: string) =>
  Effect.callback<void, SqliteSnapshotError>((resume) => {
    const fail = (cause: unknown) =>
      resume(Effect.fail(new SqliteSnapshotError({ sourcePath, snapshotPath, cause })));
    const worker = new NodeWorkerThreads.Worker(snapshotWorkerSource, {
      eval: true,
      workerData: { sourcePath, snapshotPath },
    });
    worker.once("error", fail);
    worker.once("exit", (code) =>
      code === 0 ? resume(Effect.void) : fail(`Snapshot worker exited with ${code}`),
    );
    // 中断はワーカーの終了まで待つので、呼び出し側は書きかけのファイルを消せる。
    return Effect.promise(() => worker.terminate());
  });
