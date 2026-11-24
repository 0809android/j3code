# J3 Code ハンドオフ & 実装状況

`pingdotgg/t3code` をベースにした **J3 Code（J3コード）** のフォークリポジトリ。

## リポジトリ・ブランチ

- **GitHub（Public）**: `https://github.com/0809android/j3code`（`origin`）
- **本家リモート**: `upstream` = `https://github.com/pingdotgg/t3code.git`（push は `DISABLED`）
- **ブランチ**:
  - `main`: 本家 `upstream/main`（`7182abeeaa`）追従専用
  - `develop`: J3 Code 実装ブランチ

## 実装済み機能一覧

### 1. 既存ローカル資産の取り込み（`b01ad962ba`）

- **OpenDesign Cloud 統合**: `packages/provider-opencode/src/server/openDesign.ts` + 認証・使用量表示（Web / Mobile / Server / Contracts / Shared）を取り込み済み。
- **Antigravity OAuth 使用量不一致修正**: `apps/server/src/provider/antigravityUsageLimits.ts` にて `antigravity-oauth-token` を旧 `acp_token.json` より優先し、期限切れ時は旧 client 資格情報＋最新 `refresh_token` で更新するように修正済み（上流の keyring 経路も維持）。

### 2. J3 Code ブランディング・多言語（i18n）・モバイル PWA 対応

- `apps/web/src/branding.ts`・`apps/web/vite.config.ts`・`apps/web/index.html`・`apps/web/public/manifest.webmanifest` を **J3 Code** 化。
- モバイル PWA 向けメタタグ（`apple-mobile-web-app-capable`, `apple-mobile-web-app-title`, `orientation: "any"`）を整備。
- 既存の `gt-i18n`（`en` / `ja` / `zh` ほか全9言語）を活かし、新規追加した設定 UI 文言も多言語カタログへ登録・`vp run i18n:check` で検証。
- スマホからはネイティブアプリの再ビルド不要で、`vp run dev --share`（Tailscale）経由で PWA / ブラウザから操作可能。

### 3. プロバイダエラー時のセカンダリ自動フォールバック

- **設定スキーマ** (`packages/contracts/src/settings.ts`, `packages/client-runtime/src/state/sharedSettings.ts`):
  - `providerFallbackOnError`: 自動フォールバック ON/OFF
  - `providerFallbackChain`: 優先順位付きセカンダリプロバイダ＋モデル配列（最大5件）
  - `providerFallbackErrorClasses`: 対象エラー分類（`usage_limit` / `provider_error` / `transport_error` / `unknown`。`validation_error` と `permission_error` は安全のため常に除外）
  - `providerFallbackMaxAttempts`: 連続フォールバック上限（1〜5、既定2）
- **サーバー自動実行ワーカー** (`apps/server/src/orchestration-v2/ProviderFallbackWorker.ts`, `ProjectionStore.ts`, `runtimeLayer.ts`):
  - 失敗ランを検知し、有効かつ未失敗の次候補へ `message.dispatch`（`modelSelection` 指定・冪等 `commandId`）を発行。
  - T3 Code 既存の `ProviderSwitchService` + `ContextHandoffService` により会話コンテキストを自動引き継ぎ。
  - 10分以上前の古い失敗や連続上限到達時は発火しないループ防止ガード付き。
- **設定 UI** (`apps/web/src/components/settings/ProviderFallbackSettings.tsx`, `SettingsPanels.tsx`, `settingsSearch.ts`):
  - Settings → Threads 内の「Provider fallback」セクションから ON/OFF、優先順位チェーンの追加・並替・削除、対象エラー分類、最大試行回数を設定可能。

### 4. 未対応プロバイダ・直接 API 対応（`packages/provider-openai-compatible`）

- 新規組み込みドライバ `openai-compatible`（複数インスタンス対応）を実装し、`builtInDrivers.ts` / `managedProviders.ts` / `providerClients.ts` へ登録。
- **内蔵プリセット**:
  - **Mistral AI** (`https://api.mistral.ai/v1`, `MISTRAL_API_KEY`, Devstral / Codestral / Mistral Large)
  - **OpenDesign Cloud** (`https://amr-api.open-design.ai/v1`, `OPENDESIGN_API_KEY`)
  - **OpenRouter** (`https://openrouter.ai/api/v1`, `OPENROUTER_API_KEY`)
  - **DeepSeek** (`https://api.deepseek.com/v1`, `DEEPSEEK_API_KEY`)
  - **Ollama (Local)** (`http://127.0.0.1:11434/v1`)
  - **Custom OpenAI-Compatible API**（任意の Base URL + API キー）
- `/models` 自動検出、SSE ストリーミング + ツール呼び出し（`read_file`, `list_directory`, `write_file`, `edit_file`, `run_command`）、`injectHistory`（フォールバック引き継ぎ対応）、HTTP ステータス→エラー分類（429→`usage_limit`, 5xx→`provider_error`, 401/403→`permission_error`, 400/422→`validation_error`）、`ProviderTextGeneration` 実装済み。

### 5. ネイティブスマホアプリ（`apps/mobile`：iOS / Android Expo アプリ）

- **J3 Code ブランディング・識別子更新** (`apps/mobile/app.config.ts`, `apps/mobile/app.config.test.ts`, `apps/mobile/src/App.tsx`, `apps/mobile/src/components/BrandMark.tsx`, `apps/mobile/src/components/CompactBrandTitle.tsx`, `apps/mobile/src/features/layout/workspace/ListSearchToolbar.android.tsx`, `apps/mobile/src/features/layout/workspace/WorkspaceListHeader.android.tsx`, `apps/mobile/package.json`):
  - アプリ名: `J3 Code` / `J3 Code Dev` / `J3 Code Preview`
  - バンドル ID / パッケージ名: `com.j3tools.j3code` / `.dev` / `.preview`
  - ディープリンク: `j3code://`, `j3code-dev://`, `j3code-preview://`（旧 `t3code*` スキームとの互換性も維持）
  - Universal Links / App Links (`apps/web/public/.well-known/apple-app-site-association.json`, `assetlinks.json`) へ `com.j3tools.j3code*` を追加。
- **モバイル設定 UI & プロバイダ対応 & J3 独自拡張（`apps/mobile/src/features/j3/`）**:
  - `apps/mobile/src/features/settings/MobileProviderFallbackSection.tsx` を新設し、Settings → Threads から自動フォールバック ON/OFF、セカンダリプロバイダチェーンの追加・並替・削除、対象エラー分類、最大試行回数をネイティブ操作可能に。
  - 本家 UI・全機能を維持しつつ、独自機能を `apps/mobile/src/features/j3/` へ分離実装（既存画面への差し込みは最小限）：
    - `J3QuickPromptsBar.tsx`: コンポーザー上部に片手 1 タップのクイック指示チップバー（折りたたみ対応・入力中/音声入力中/スラッシュコマンド時は自動非表示）。
    - `J3ConnectionProbeCard.tsx` + `j3ConnectionProbe.ts`: 接続画面で Tailscale（`.ts.net` / `100.64.0.0/10`）・`j3-relay-proxy`（`:8787` / `/healthz`）・ローカル LAN・リモートを自動判定し、疎通＆レイテンシ計測を実行。
    - `J3OpsSummaryBanner.tsx` + `j3OpsSummary.ts`: ホーム一覧・サイドバー上部に実行中/要対応/失敗件数と自動フォールバック ON/OFF を 1 行表示（タップで Settings → Threads へ直行）。
  - `apps/mobile/eas.json` の `preview` プロファイルに `android.buildType: "apk"` を追加し、EAS 経由で Android 実機用 APK を直接生成可能に。
  - `apps/mobile/src/lib/contextChipIcons.generated.ts` へ `openai-compatible` アイコンを追加。
  - モバイル版 `gt-i18n` カタログ（`apps/mobile/src/i18n/translations/*.json`）へ新規キーを全9ロケール（`ja` / `zh` / `ko` / `de` / `es` / `fr` / `pt-BR` / `ru` / `sv`）翻訳反映済み。

### 6. デスクトップアプリ（`apps/desktop`：Electron）の J3 Code 化 & 本家 T3 Code との分離

- **ブランディング & アプリ識別子** (`apps/desktop/package.json`, `apps/desktop/src/app/DesktopEnvironment.ts`, `apps/desktop/src/app/DesktopEarlyElectronStartup.ts`):
  - `productName` を `J3 Code (Beta)`、`APP_BASE_NAME` を `J3 Code` へ更新（`window.desktopBridge.getAppBranding()` 経由でレンダラにも正しく注入）。
  - Windows `appUserModelId` を `com.j3tools.j3code`（開発: `.dev`）、Linux `.desktop` エントリを `com.j3tools.J3Code.desktop` へ分離。
- **本家 T3 Code との安全な共存分離** (`apps/desktop/src/app/DesktopUserData.ts`, `apps/desktop/src/app/DesktopStatePaths.ts`, `apps/desktop/src/app/DesktopConfig.ts`):
  - Electron プロファイルを `j3code-v2` / `j3code-dev` へ分離。
  - データディレクトリの既定値を `~/.j3`（`J3CODE_HOME` > `T3CODE_HOME` > `~/.j3`）とし、稼働中の本家 T3 Code (`~/.t3/userdata`) と衝突せず安全に同時起動可能に。
- **OpenAI 互換 API 設定フォーム改善 & i18n チェック修正**:
  - `packages/provider-openai-compatible/src/settings.ts`: `preset` フィールドに `control: "select"` と 6 プリセット選択肢を定義し、Web 設定画面・追加ウィザードでドロップダウン選択可能に修正。
  - `apps/web/src/components/settings/ProviderSettingsForm.tsx`: 新規設定項目・説明文・プリセット表示名を `PACKAGE_FIELD_TEXT` に登録し、全9ロケールへ翻訳反映。
  - `scripts/i18n-check.ts`: Windows 環境でも `vp run i18n:check` が通るよう `gt` CLI 呼び出しをクロスプラットフォーム化。

### 7. ハイブリッド Rust ネイティブ拡張（`native/j3-*`）

- **`native/j3-usage-scanner`**: 並列ディレクトリ走査＋SIMD 行マーカーフィルタ＋FNV-1a ガード検証＋Pure Rust Zstd 展開＋`--serve` NDJSON 永続ワーカー。[NativeUsageScanner.ts](./apps/server/src/usage/NativeUsageScanner.ts) 経由で [usageTranscriptReader.ts](./apps/server/src/usage/usageTranscriptReader.ts)（256KB 以上または `.jsonl.zst` で自動使用、未ビルド時は既存 TS へ自動フォールバック）に統合。
- **`native/j3-workspace-search`**: `ignore` + `regex::bytes` SIMD プリフィルタ＋`--serve` NDJSON 永続ワーカーによる高速ファイル検索・全文 grep・diff 統計・`check-ignore`。[NativeWorkspaceSearch.ts](./apps/server/src/workspace/NativeWorkspaceSearch.ts) 経由で [WorkspaceEntries.ts](./apps/server/src/workspace/WorkspaceEntries.ts)（フォルダ展開時の `check-ignore` 高速化含む）および [tools.ts](./packages/provider-openai-compatible/src/server/tools.ts)（`search_files` / `grep_files` 永続ワーカー＋[adapter.ts](./packages/provider-openai-compatible/src/server/adapter.ts) の読み取り系ツール並列実行）に統合。
- **`native/j3-relay-proxy`**: 外部依存ゼロの超軽量 HTTP/1.1（Keep-Alive 対応）+ WebSocket 双方向リレープロキシ（`/healthz`・定数時間 Bearer 認証・同時接続上限・`--static-dir` によるインメモリキャッシュ / `.gz` / `ETag 304` 静的配信付き）。
- **SQLite & Electron 同梱**: [Sqlite.ts](./apps/server/src/persistence/Sqlite.ts) に `cache_size = -32768`（32MB）と `mmap_size = 134217728`（128MB）を追加。[stage-native-binaries.mjs](./scripts/stage-native-binaries.mjs) と [build-desktop-artifact.ts](./scripts/build-desktop-artifact.ts) で Electron 配布版へ Rust バイナリを自動同梱可能。
- ルート `package.json` に `build:usage-scanner` / `build:workspace-search` / `build:relay-proxy` / `stage:native` / `build:native` / `test:native` を追加。

## 起動方法（開発・スマホアクセス）

```powershell
# ローカル起動（Server + Web）
.\node_modules\.bin\vp.cmd run dev

# スマホから Tailscale 経由で操作（PWA 対応）
.\node_modules\.bin\vp.cmd run dev --share

# ネイティブスマホアプリ（Expo dev client）起動・ビルド
.\node_modules\.bin\vp.cmd run --filter @t3tools/mobile dev:client
.\node_modules\.bin\vp.cmd run --filter @t3tools/mobile android:dev
.\node_modules\.bin\vp.cmd run --filter @t3tools/mobile ios:dev
.\node_modules\.bin\vp.cmd run --filter @t3tools/mobile eas:android:dev
.\node_modules\.bin\vp.cmd run --filter @t3tools/mobile eas:ios:dev
```

## 検証・残タスク

- [x] `vp i` 完了・新規ワークスペース `@t3tools/provider-openai-compatible` リンク済み
- [x] `vp run i18n:generate`（`apps/web`・`apps/mobile`）実行 & 全9ロケール翻訳反映・キー整合性確認済み
- [x] 対象パッケージ（`contracts`, `client-runtime`, `provider-opencode`, `provider-openai-compatible`, `apps/server`, `apps/web`, `apps/desktop`, `apps/mobile`）の型チェック 0 エラー確認済み
- [x] 対象単体テスト全通過確認済み（サーバー・プロバイダ・デスクトップ・Web・モバイル）
- [x] GitHub（`origin`）へ push 済み

## `upstream/main` 追従（`rebase`）運用ルール

本家更新は `git rebase upstream/main` で取り込みます。詳しい手順と今後の開発規約は **[docs/REBASE_UPSTREAM.md](./docs/REBASE_UPSTREAM.md)** を参照してください。

- **翻訳 JSON の自動復元**: J3 Code 独自の翻訳は [scripts/j3-i18n-overrides.json](./scripts/j3-i18n-overrides.json) に外出ししています。
  - rebase 中に `apps/*/src/i18n/translations/*.json` がコンフリクトしたら、本家側（`git checkout --ours`）を採用したうえで **`vp run j3:i18n:sync`** を実行すれば、`gt generate` と J3 独自訳の再注入が一括完了します。
  - 新しく J3 独自の文言・翻訳を追加したときは、最後に **`vp run j3:i18n:capture`** を実行してオーバーレイを更新してください。
- **ロックファイルの自動復元**: `pnpm-lock.yaml` がコンフリクトしたら `git checkout --ours pnpm-lock.yaml` の後に `vp i` で再生成します。
- **コミット設計**: 独自コードは新規ディレクトリ・ファイルに分離し、自動生成物（翻訳 JSON・`pnpm-lock.yaml`）は末尾コミットに集約して rebase 時の衝突回数を最小限に保ちます。
