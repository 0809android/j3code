<h1 align="center">J3 Code</h1>

<p align="center">
  <strong>多言語対応・自動プロバイダフォールバック・直接 API 連携を備えた T3 Code 拡張フォーク</strong><br />
  An extended fork of <a href="https://github.com/pingdotgg/t3code">T3 Code</a> with multilingual UI, automatic secondary provider fallback, OpenAI-compatible direct APIs, and isolated side-by-side operation.
</p>

<p align="center">
  <a href="#本家-t3-code-からの主な追加変更点">追加機能 (Diff from Upstream)</a> ·
  <a href="#クイックスタート">クイックスタート</a> ·
  <a href="#スマホからの操作pwa--ネイティブアプリ">スマホ操作</a> ·
  <a href="#ブランチ構成と本家追従方針">ブランチ方針</a> ·
  <a href="./HANDOFF.md">開発ハンドオフ</a> ·
  <a href="./docs/README.md">Docs</a>
</p>

---

**J3 Code** は、オープンソースのコーディングエージェント制御 UI である [T3 Code (`pingdotgg/t3code`)](https://github.com/pingdotgg/t3code)（MIT ライセンス）をベースに、**日本語を含む多言語運用・プロバイダ障害時の自動フォールバック・未対応 API プロバイダ（Mistral / OpenDesign / OpenRouter / DeepSeek / Ollama 等）への直接対応** を追加した独自フォークです。

本家 T3 Code が対応する Claude Code / Codex / Cursor / OpenCode / Grok Build / Antigravity / Kiro / Pi / Muse Code / fx / ACP エージェントの全機能を引き継ぎつつ、以下の独自拡張を組み込んでいます。

---

## 本家 T3 Code からの主な追加・変更点

| 領域                                   | 本家 T3 Code (`upstream/main`)         | J3 Code (`develop`) での追加・変更                                                                                                              |
| :------------------------------------- | :------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| **エラー時自動フォールバック**         | 手動切り替えのみ                       | **優先順位付きセカンダリチェーン（最大5件）へ自動引き継ぎ**（Web / Mobile 設定 UI + サーバーワーカー）                                          |
| **OpenAI 互換 API 直接対応**           | 未対応（CLI / ACP 経由のみ）           | **新規組み込みドライバ `openai-compatible`**（Mistral AI / OpenDesign Cloud / OpenRouter / DeepSeek / Ollama / Custom）                         |
| **OpenDesign Cloud 統合**              | 未対応                                 | **OpenCode プロバイダでの OpenDesign デバイス認証・コーディングプラン使用量表示**を追加                                                         |
| **Antigravity 使用量取得**             | 旧 `acp_token.json` と競合する場合あり | **`antigravity-oauth-token` を優先参照**し、期限切れ時のリフレッシュ経路を修正                                                                  |
| **全サーフェス J3 Code 化 & 共存分離** | `~/.t3` / `t3code-v2` 固定             | **Web・PWA・Desktop（Electron）・Mobile（Expo）すべて J3 Code 化**。Desktop は `~/.j3` / `j3code-v2` へ分離し本家と同時起動可能                 |
| **多言語対応（i18n）**                 | 本家既存キーのみ                       | **新規追加した全 UI 文言（フォールバック設定・API プリセット設定等）を `ja` / `zh` / `en` 含む全 9 ロケールへ翻訳** + Windows 対応 `i18n:check` |

### 1. プロバイダエラー時のセカンダリ自動フォールバック

使用中のプロバイダでレート制限（`usage_limit`）やサーバー障害（`provider_error`）、接続エラー（`transport_error`）が発生した際、**会話コンテキストを自動で引き継いだまま次の優先プロバイダ／モデルへ切り替えてタスクを継続**します。

- **設定項目**（Web: `Settings → Threads → Provider fallback` / Mobile: `Settings → Threads`）:
  - 自動フォールバック ON / OFF（`providerFallbackOnError`）
  - 優先順位付きセカンダリチェーン（最大 5 件の追加・並び替え・削除、`providerFallbackChain`）
  - 発火対象エラー分類の選択（`usage_limit` / `provider_error` / `transport_error` / `unknown`。※`validation_error` と `permission_error` は安全のため常に除外）
  - 連続自動フォールバックの上限回数（1〜5 回、既定 2 回、`providerFallbackMaxAttempts`）
- **安全ガード**（[ProviderFallbackWorker.ts](./apps/server/src/orchestration-v2/ProviderFallbackWorker.ts)）:
  - 10 分以上前の過去失敗には発火しないガード、冪等 `commandId` による二重実行防止、連続試行上限、一時的なディスパッチ失敗時の 15 秒バックオフ再試行を実装。

### 2. 未対応プロバイダ・直接 API 対応（`@t3tools/provider-openai-compatible`）

CLI ラッパーを必要とせず、OpenAI 互換 Chat Completions API を直接呼び出せる組み込みドライバを追加しました（複数インスタンス作成対応のため、Mistral と OpenDesign 等を並べてフォールバックチェーンに組み込めます）。

- **内蔵プリセット**（設定画面からドロップダウンで選択可能）:
  - **Mistral AI**（`https://api.mistral.ai/v1` / `MISTRAL_API_KEY` — Devstral / Codestral / Mistral Large 等）
  - **OpenDesign Cloud**（`https://amr-api.open-design.ai/v1` / `OPENDESIGN_API_KEY`）
  - **OpenRouter**（`https://openrouter.ai/api/v1` / `OPENROUTER_API_KEY`）
  - **DeepSeek**（`https://api.deepseek.com/v1` / `DEEPSEEK_API_KEY`）
  - **Ollama (Local)**（`http://127.0.0.1:11434/v1`）
  - **Custom OpenAI-Compatible API**（任意の `http://` / `https://` エンドポイント）
- **主な機能とセキュリティ対策**:
  - `/models` によるモデル自動検出、SSE リアルタイムストリーミング、`injectHistory` によるフォールバック引き継ぎ、HTTP ステータス→エラー分類（429→`usage_limit`, 5xx→`provider_error`, 401/403→`permission_error`）。
  - ローカルコーディングツール（`read_file`, `list_directory`, `write_file`, `edit_file`, `run_command`）を内蔵。`realpath` 検証によるシンボリックリンク経由のワークスペース外アクセス遮断、`runtimeMode` 連動の権限ガード、中断／タイムアウト時のプロセスツリー終了を実装。
  - `baseUrl` の `http://` / `https://` スキーム検証、シークレットストア分離保存、通信エラー時の `Bearer` トークン自動マスク（`[REDACTED]`）を実装。

### 3. OpenDesign Cloud 統合 & Antigravity OAuth 使用量修正

- **OpenDesign Cloud**（[openDesign.ts](./packages/provider-opencode/src/server/openDesign.ts)）: OpenCode プロバイダに公式デバイス認可フロー（`https://open-design.ai/cloud/cli/activate` のみ許可）とコーディングプラン使用量表示を統合（Web / Mobile / Server 対応）。
- **Antigravity OAuth 修正**（[antigravityUsageLimits.ts](./apps/server/src/provider/antigravityUsageLimits.ts)）: 最新の `antigravity-oauth-token` を旧 `acp_token.json` より優先読み取りし、アカウント切替後の使用量不一致を解消。

### 4. Web / PWA・Desktop・Mobile 全サーフェス J3 Code 化 & 本家共存分離

- **Desktop アプリ（`apps/desktop`）**:
  - `productName`: `J3 Code (Beta)`、`appUserModelId`: `com.j3tools.j3code`（開発: `.dev`）、Linux `.desktop`: `com.j3tools.J3Code.desktop`。
  - Electron プロファイルを `j3code-v2` / `j3code-dev`、データディレクトリの既定値を `~/.j3`（環境変数優先順: `J3CODE_HOME` > `T3CODE_HOME` > `~/.j3`）に分離しているため、**本家 T3 Code（`~/.t3/userdata`）と衝突せず安全に同時起動**できます。
- **Web / モバイル PWA（`apps/web`）**:
  - `manifest.webmanifest`（`display: "standalone"`）とモバイル用メタタグを J3 Code 化。ネイティブビルドなしでもスマホのホーム画面に追加して全機能を利用可能。
- **ネイティブモバイルアプリ（`apps/mobile`）**:
  - もとの UI・全機能（スレッド操作・差分レビュー・ファイル閲覧・音声入力・使用量・QR ペアリング等）をすべて維持したまま、J3 Code 独自拡張を `apps/mobile/src/features/j3/` に分離追加。
  - アプリ名 `J3 Code`、Bundle ID / Package 名 `com.j3tools.j3code`（`.dev` / `.preview`）、ディープリンク `j3code://`（旧 `t3code://` 互換維持）。
  - **片手クイック指示チップ**（チャット入力欄上部から 1 タップで「続き」「テスト実行」「差分要約」「エラー修正」「確認してコミット」を挿入・折りたたみ可能）。
  - **Tailscale / `j3-relay-proxy` 自動判定 & 接続テスト**（接続画面で入力アドレスの経路種別を自動判定し、`/healthz`・`/api/auth/session` の疎通と応答時間を確認可能）。
  - **稼働 & 自動フォールバック状況サマリ**（スレッド一覧上部に実行中・要対応・失敗件数と自動フォールバック ON/OFF を 1 行表示し、1 タップで設定画面へ遷移）。
  - Settings → Threads にフォールバック設定画面（検索フィルタ付き）を追加。
  - `apps/mobile/eas.json` の `preview` プロファイルで Android 実機直入れ用 APK を出力可能（EAS / Apple Team ID は `J3CODE_EAS_PROJECT_ID`・`J3CODE_EAS_OWNER`・`J3CODE_APPLE_TEAM_ID` で注入）。

### 5. 多言語対応（全 9 言語）

- `en` / `ja` / `zh` / `ko` / `de` / `es` / `fr` / `pt-BR` / `ru` / `sv` の全カタログに対して新規 UI 文言・API プリセット設定ラベルを翻訳反映。
- [scripts/i18n-check.ts](./scripts/i18n-check.ts) を Windows 環境でも実行できるようクロスプラットフォーム化。

### 6. ハイブリッド Rust アクセラレータ（`native/j3-*`）

コアは本家 T3 Code と同じ TypeScript + Effect を維持して上流追従性を保ちつつ、CPU・メモリ負荷が集中する 3 領域を Rust ネイティブバイナリ化しました（バイナリ未ビルド環境では既存 TypeScript 実装へ自動フォールバックします）。

- **`native/j3-usage-scanner`**（使用量ログ高速スキャン）:
  - `rayon` 並列ディレクトリ走査＋`stat`、`memchr` SIMD マーカー検索、`ruzstd`（Pure Rust）Zstd 展開、TS 実装とビット一致する FNV-1a 64 バイトガード検証を実装。`--serve` NDJSON 永続ワーカー（30 秒アイドル自動終了）と 256KB 閾値ハイブリッド判定により、[usageTranscriptReader.ts](./apps/server/src/usage/usageTranscriptReader.ts) から高速に自動利用されます。
- **`native/j3-workspace-search`**（大規模リポジトリ検索・Diff 統計・gitignore 判定）:
  - `ignore`（ripgrep 系 `.gitignore` 並列ウォーカー）＋`regex::bytes` SIMD プリフィルタ＋`--serve` NDJSON 永続ワーカーによる高速ファイル検索（`files`）、全文検索（`grep`）、Unified Diff 統計解析（`diff-stat`）、フォルダ展開時の `.gitignore` 一括判定（`check-ignore`）を実装。[WorkspaceEntries.ts](./apps/server/src/workspace/WorkspaceEntries.ts) と OpenAI 互換プロバイダの `search_files` / `grep_files` ツール（永続ワーカー＋読み取り系ツール並列実行）から利用されます。
- **`native/j3-relay-proxy`**（超軽量 VPS 常駐向け HTTP + WebSocket リレー & 静的配信）:
  - 外部クレート依存ゼロ（Rust `std` のみ）で動作する HTTP/1.1（Keep-Alive 対応）+ WebSocket 双方向リバースプロキシ。`/healthz`、定数時間比較の Bearer 認証（`--auth-token` / `J3_RELAY_AUTH_TOKEN`）、同時接続数上限（`--max-connections`）、64KB ヘッダ上限に加え、`--static-dir`（`J3_RELAY_STATIC_DIR`）によるインメモリキャッシュ・事前圧縮 `.gz`・`ETag / 304` 静的アセット直接配信を内蔵。
- **その他パフォーマンス最適化**:
  - [Sqlite.ts](./apps/server/src/persistence/Sqlite.ts) にて SQLite ページキャッシュ（32MB）とメモリマップ読み取り（128MB）を有効化。
  - `vp run build:native`（`vp run stage:native`）でビルド済み Rust バイナリを `apps/desktop/prod-resources/j3-native/` へ自動ステージングし、Electron デスクトップ配布版にも同梱可能。

```powershell
# Rust バイナリの一括ビルド & テスト
.\node_modules\.bin\vp.cmd run build:native
.\node_modules\.bin\vp.cmd run test:native

# 超軽量リレープロキシの起動例（VPS 等）
j3-relay-proxy --listen 0.0.0.0:8787 --upstream 127.0.0.1:3773 --auth-token "<secret>" --max-connections 256
```

---

## クイックスタート

### 前提条件

- Node.js（`package.json` の `engines.node` 準拠）および pnpm / Vite+（`vp`）
- いずれか 1 つ以上のコーディングエージェント CLI、または Mistral / OpenDesign / OpenRouter / DeepSeek / Ollama などの API キー

### 依存インストール & 開発起動

```powershell
# 依存パッケージのインストール
.\node_modules\.bin\vp.cmd i

# Server + Web UI の起動（ローカル）
.\node_modules\.bin\vp.cmd run dev

# Desktop（Electron）アプリの起動
.\node_modules\.bin\vp.cmd run dev:desktop
```

macOS / Linux の場合は `vp i` / `vp run dev` / `vp run dev:desktop` で実行できます。

### スマホからの操作（PWA / ネイティブアプリ）

#### 方法 A: PWA（最短・ビルド不要）

```powershell
# Tailscale 経由で共有起動し、出力される pairingUrl をスマホで開く
.\node_modules\.bin\vp.cmd run dev --share
```

- **iOS (Safari)**: 共有ボタン →「ホーム画面に追加」→ **J3 Code** として起動
- **Android (Chrome)**: メニュー →「アプリをインストール」または「ホーム画面に追加」

#### 方法 B: ネイティブアプリ（`apps/mobile`）

```powershell
.\node_modules\.bin\vp.cmd run --filter @t3tools/mobile dev:client
.\node_modules\.bin\vp.cmd run --filter @t3tools/mobile android:dev
.\node_modules\.bin\vp.cmd run --filter @t3tools/mobile ios:dev
# Android 実機インストール用 APK ビルド（EAS preview）
.\node_modules\.bin\vp.cmd run --filter @t3tools/mobile eas:android:preview
```

※ EAS ビルドや OTA 更新を使う場合は `J3CODE_EAS_PROJECT_ID`・`J3CODE_EAS_OWNER`・`J3CODE_APPLE_TEAM_ID` を設定してください。

---

## 検証コマンド

```powershell
# 変更差分に対するフォーマット・Lint・Knip・型チェック・単体テスト・React Compiler 検証
.\node_modules\.bin\vp.cmd run check:changed main

# 多言語カタログ整合性チェック（Web / Mobile / Desktop）
.\node_modules\.bin\vp.cmd run i18n:check
```

---

## ブランチ構成と本家追従方針

- `main`: 本家 `upstream/main`（`pingdotgg/t3code`）のクリーンな追従専用ブランチ
- `develop`: J3 Code の独自機能・修正を管理するメイン開発ブランチ（本家更新は **`git rebase upstream/main`** で取り込み）
- rebase 時のコンフリクト解消手順（`vp run j3:i18n:sync` による翻訳自動再注入・`pnpm-lock.yaml` 再生成）および今後の開発ルールは **[docs/REBASE_UPSTREAM.md](./docs/REBASE_UPSTREAM.md)** を参照してください。
- 実装の詳細・残タスクは [HANDOFF.md](./HANDOFF.md) を参照してください。

---

## ドキュメント & クレジット

- 利用ガイド・アーキテクチャ詳細は [docs/README.md](./docs/README.md) を参照してください。
- Upstream project: [pingdotgg/t3code](https://github.com/pingdotgg/t3code)

## ライセンス

[MIT](./LICENSE)
