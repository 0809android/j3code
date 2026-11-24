# 本家（`upstream/main`）追従 & Rebase 運用ガイド

J3 Code は [pingdotgg/t3code](https://github.com/pingdotgg/t3code) のフォークであり、今後の本家更新は **`git rebase upstream/main`** で `develop` ブランチへ取り込みます。

このドキュメントでは、rebase 時のコンフリクトを最小限に抑えるための **標準手順** と **今後の開発ルール** を定義します。

---

## 1. 本家更新の取り込み手順（`rebase`）

### Step 1: 本家の最新を取得して `main` を更新する

```powershell
git fetch upstream
git checkout main
git merge --ff-only upstream/main
git push origin main
```

### Step 2: `develop` を `upstream/main` 上にリベースする

```powershell
git checkout develop
git rebase upstream/main
```

### Step 3: 自動生成ファイルでコンフリクトしたときの定型解消

`develop` では **`pnpm-lock.yaml` と翻訳 JSON（`apps/*/src/i18n/translations/*.json`）の更新を末尾の専用コミットに集約** しています。これらのファイルでコンフリクトした場合は、手動マージせず以下の機械的手順で解消します。

> **注意（rebase 時の `--ours` / `--theirs` の向き）**:
> `git rebase` 中は、**`--ours` が本家側（`upstream/main`）**、**`--theirs` が J3 Code 側** になります。

#### 翻訳 JSON（`apps/web` / `apps/mobile` / `apps/desktop`）がコンフリクトした場合

```powershell
# 1. いったん本家側の翻訳 JSON をそのまま採用する
git checkout --ours apps/web/src/i18n/translations apps/mobile/src/i18n/translations apps/desktop/src/i18n/translations

# 2. gt generate の再実行 + J3 独自訳の自動再注入を一括実行する
.\node_modules\.bin\vp.cmd run j3:i18n:sync

# 3. 整合性チェック
.\node_modules\.bin\vp.cmd run i18n:check

# 4. ステージして続行
git add apps/web/src/i18n/translations apps/mobile/src/i18n/translations apps/desktop/src/i18n/translations
```

#### `pnpm-lock.yaml` がコンフリクトした場合

```powershell
# 本家側の lockfile を採用して再生成する
git checkout --ours pnpm-lock.yaml
.\node_modules\.bin\vp.cmd i
git add pnpm-lock.yaml
```

#### 解消後にリベースを続行

```powershell
git rebase --continue
```

### Step 4: 最終検証 & プッシュ

```powershell
# フォーマット・Lint・Knip・i18n・型チェック・テスト
.\node_modules\.bin\vp.cmd fmt
.\node_modules\.bin\vp.cmd run i18n:check
.\node_modules\.bin\vp.cmd run knip:check
.\node_modules\.bin\vp.cmd run check:changed
.\node_modules\.bin\vp.cmd run test:native

# Rust バイナリを再ビルド（必要な場合）
.\node_modules\.bin\vp.cmd run build:native

# origin/develop へ安全に反映（upstream には絶対に push しない）
git push --force-with-lease origin develop
```

---

## 2. 今後の開発ルール（Rebase しやすさを保つため）

新機能や修正を追加するときは、以下の 6 原則を必ず守ってください。

1. **独自コードは専用ディレクトリ／新規ファイルに分離する**
   - 本家既存ファイルへの変更は「import と数行のフック・JSX 差し込み」に留める。
   - 置き場所の基準：
     - Rust ネイティブ拡張: `native/j3-*`
     - モバイル独自機能: `apps/mobile/src/features/j3/`
     - 独自プロバイダ: `packages/provider-*`
     - サーバー独自ワーカー / アダプタ: `apps/server/src/.../Native*.ts` や `ProviderFallbackWorker.ts` 等の独立ファイル
2. **翻訳を追加・変更したら必ずオーバーレイを更新する**
   - UI 文言（`gt(...)` / `<T>` / `msg(...)`）を追加したら、各ロケール（`ja` / `zh` 含む全言語）へ翻訳を入れた後、`upstream/main` がローカルに存在することを確認して以下を実行し [scripts/j3-i18n-overrides.json](../scripts/j3-i18n-overrides.json) へ記録する（`baseRef` 未存在時は安全のためエラー終了します）：
     ```powershell
     .\node_modules\.bin\vp.cmd run j3:i18n:capture
     .\node_modules\.bin\vp.cmd run i18n:check
     ```
   - `vp run j3:i18n:sync` は同期後に自動で `vp fmt` を実行するため、次回の rebase で翻訳 JSON を本家へリセットしても 1 コマンドで J3 独自訳とフォーマットが 100% 自動復元されます。
3. **本家の高頻度更新ファイル（`translations/*.json`・`pnpm-lock.yaml`）を複数コミットに散らさない**
   - 機能コミットに翻訳 JSON や `pnpm-lock.yaml` の変更を何度も混ぜると、rebase 時にコミット数と同じ回数だけコンフリクトします。
   - 大きな開発が一区切りついたら、自動生成物（`translations/*.json` / `pnpm-lock.yaml`）や修正コミット（fixup）を整理して、機能単位のクリーンなコミット列を保ちます。
4. **試行錯誤で「作って消した」往復コミットを残さない**
   - 撤回した試作機能はそのまま別コミットで削除せず、親コミットと squash して履歴から取り除きます。
5. **本家と共存するデータパス・識別子を壊さない**
   - Desktop データ領域は `~/.j3`（`J3CODE_HOME` > `T3CODE_HOME` > `~/.j3`）、プロファイルは `j3code-v2` を維持し、本家 T3 Code（`~/.t3/userdata`）と衝突させない。
   - `upstream` リモートは push 無効化（`DISABLED`）を維持する。
6. **進捗と構造変更は `HANDOFF.md` に記録する**
   - どの本家ファイルにフックを差し込んでいるか、どの独自パッケージ・スクリプトがあるかを常に最新化し、rebase 時に影響範囲を即座に追える状態を保ちます。

---

## 3. 現在の `develop` コミット構成（機能単位）

rebase 時の見通しと競合回避のため、`develop` の独自差分は以下の機能単位に整理されています：

1. **OpenDesign Cloud 統合 & Antigravity OAuth 使用量修正**
2. **プロバイダエラー時セカンダリ自動フォールバック**（Contracts / Server / Web / Mobile）
3. **OpenAI 互換直接 API プロバイダ**（`packages/provider-openai-compatible` + 登録 + 設定 UI）
4. **J3 Code ブランディング & 本家共存分離**（Web PWA / Desktop / Mobile + EAS APK 設定）
5. **ハイブリッド Rust アクセラレータ & 性能最適化**（`native/j3-*` / SQLite / Electron バイナリ同梱）
6. **モバイル J3 独自拡張**（`apps/mobile/src/features/j3/`: クイック指示・接続テスト・稼働サマリ）
7. **J3 運用基盤・翻訳カタログ・ロックファイル・ドキュメント集約**（`j3:i18n:sync`・`translations/*.json`・`pnpm-lock.yaml`・`docs/REBASE_UPSTREAM.md`・`README.md`・`HANDOFF.md`）
