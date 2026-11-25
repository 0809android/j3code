# K3 Relay

NAT の内側にある K3 ホストへ、スマホや別 PC からつなぐための中継サーバーです。ホストと端末の間で暗号文をそのまま渡すだけで、通信内容は読めません（暗号化は端末とホストの間の E2E チャネルが行い、リレーはその外側にいます）。

状態: P1（非公開の試験運用）。仕様は `spec-v3.5.md`（§4 API、§5 grant、§9 上限、§10 保存データ）で、実装との差は末尾の「仕様との差」にまとめています。

- ランタイム: Node 22.18 以上（Docker イメージは Node 24）。`ws` だけに依存し、DB は Node 組み込みの `node:sqlite` です。外部の DB やクラウドは要りません。
- 1 GB のマシン（OCI の無料マイクロなど）で動かす想定です。

## 起動

### ローカル（開発）

```sh
cd infra/k3-relay
DB_PATH=./relay.sqlite PORT=8080 HOST=127.0.0.1 node src/main.ts
curl localhost:8080/health
```

`SIGTERM` / `SIGINT` で、全接続を閉じ、通信量の計数を書き出してから終了します。

### Docker

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t k3-relay infra/k3-relay
docker run --rm -p 127.0.0.1:8080:8080 -v k3-relay-data:/data k3-relay
```

イメージは `node:24-alpine` を土台に、`ws` とソースだけを入れた最小構成で、非 root（`node`）で動きます。`/data` に SQLite を置きます。

### 本番に近い形（Caddy + docker compose）

`docker-compose.example.yml` と `Caddyfile` を使います。Caddy が TLS（Let's Encrypt）を終端し、リレーは外に公開しません。

```sh
RELAY_DOMAIN=relay.example.com docker compose -f docker-compose.example.yml up -d --build
```

## 環境変数

すべて省略できます（既定値は `src/config.ts`）。数値の書き間違いは、黙って既定値に戻さず、起動時のエラーにします。

| 変数                                                                 | 既定値               | 内容                                                                                                                            |
| -------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `PORT` / `HOST`                                                      | `8080` / `0.0.0.0`   | 待ち受け                                                                                                                        |
| `DB_PATH`                                                            | `/data/relay.sqlite` | SQLite の場所                                                                                                                   |
| `TRUST_PROXY`                                                        | `0`                  | `1` で、手前のプロキシが付けた `X-Forwarded-For` の最後の値を接続元として使う。プロキシ（Caddy）の後ろに置くときだけ `1` にする |
| `REQUIRE_INVITE`                                                     | `0`                  | `1` で、登録に招待コードを要求（セルフホストで非公開にしたいとき）                                                              |
| `BLOCKED_HOSTS`                                                      | なし                 | 遮断する hostId のコンマ区切り                                                                                                  |
| `POW_SECRET`                                                         | 起動ごとにランダム   | PoW 課題の署名鍵。複数台で課題を共有するときだけ設定                                                                            |
| `POW_BASE_DIFFICULTY`                                                | `18`                 | PoW の難しさ（先頭のゼロのビット数）。登録が混むと `POW_LOAD_EXTRA_DIFFICULTY`（4）だけ上がる                                   |
| `GLOBAL_BANDWIDTH_MBPS`                                              | `45`                 | 全体の帯域。**実際の上り帯域より少し下**に置く                                                                                  |
| `MONTHLY_QUOTA_BYTES`                                                | `200000000000`       | ホストごとの月の転送量。超えると公平配分の重みが下がる（締め出さない）                                                          |
| `BUFFER_BUDGET_BYTES`                                                | `209715200`          | 全体の送信待ちバイト数の予算。1 GB のマシンでは `67108864`（64 MiB）を勧める（下の実測）                                        |
| `BACKPRESSURE_HIGH_WATER_BYTES`                                      | `1048576`            | 相手の `bufferedAmount` がこれを超えたら、送り元を一時停止                                                                      |
| `BACKPRESSURE_CLOSE_MS`                                              | `10000`              | 停止が解消しないときに切るまでの時間                                                                                            |
| `PREAUTH_MAX_PAYLOAD` / `POSTAUTH_MAX_PAYLOAD`                       | `4096` / `1048576`   | 認証前 / 認証後（スプライス）の 1 メッセージの上限                                                                              |
| `CONTROL_MAX_PAYLOAD`                                                | `65536`              | 認証後の control の上限                                                                                                         |
| `PREAUTH_MAX_CONCURRENT_PER_IP` / `PREAUTH_PER_MINUTE_PER_IP`        | `30` / `120`         | 認証前の接続の上限（IPv6 は /64 でまとめる）                                                                                    |
| `AUTH_TIMEOUT_MS`                                                    | `5000`               | nonce への返事を待つ時間                                                                                                        |
| `SESSION_SETUP_MS` / `DATA_TOKEN_TTL_MS`                             | `10000` / `10000`    | ホストが data を張るまでの時間 / token の有効時間                                                                               |
| `PING_INTERVAL_MS`                                                   | `25000`              | プロトコル層の ping の間隔                                                                                                      |
| `MAX_CONTROL_CONNECTIONS`                                            | `3000`               | control の総数                                                                                                                  |
| `MAX_SESSIONS` / `MAX_SESSIONS_PER_HOST` / `MAX_SESSIONS_PER_DEVICE` | `300` / `16` / `8`   | 同時セッション                                                                                                                  |
| `REGISTRATIONS_PER_IP_PER_DAY`                                       | `20`                 | 1 つの IP（IPv6 は /64）が 1 日に登録できるホストの数                                                                           |
| `STATUS_PER_MINUTE_PER_DEVICE`                                       | `12`                 | `status` の問い合わせ                                                                                                           |
| `PAIRING_ATTEMPTS_PER_HOUR`                                          | `10`                 | ホストごとのペアリング試行                                                                                                      |
| `MAX_HOSTS` / `MAX_GRANTS_PER_HOST`                                  | `200000` / `256`     | 登録数の上限                                                                                                                    |
| `GIT_COMMIT` / `IMAGE_DIGEST`                                        | `unknown`            | `/.well-known/k3-relay` に出す。`GIT_COMMIT` はビルド引数、`IMAGE_DIGEST` は配備のときに渡す                                    |

上限値の一覧は、実行中のリレーの `/.well-known/k3-relay` にも出ます。

## 保存するデータ

SQLite（`node:sqlite`）に、次の 5 つだけを置きます（スキーマは `src/store.ts` の `SCHEMA_SQL`。ハッシュは `/.well-known/k3-relay` の `schemaHash`）。

| テーブル      | 内容                                                                      | 保持                                 |
| ------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| `hosts`       | hostId、`Hk`、登録日、最終接続日（日単位）                                | 365 日接続がなければ削除             |
| `grants`      | hostId、deviceId、`Dk`、`alg`、grant（名前なし）、期限                    | 期限から 30 日、または失効から 30 日 |
| `revocations` | hostId、deviceId、失効の時刻、署名                                        | 30 日                                |
| `invites`     | コードのハッシュ、使用済みの印、期限（`REQUIRE_INVITE=1` のときだけ使う） | 使用後 30 日                         |
| `usage`       | hostId、月、中継したバイト数                                              | 2 か月                               |

メモリだけに置くもの: nonce、セッション、token、ペアリングの窓、IP ごとの数（IP は保存しない）、指標。

**保存しない**: 通信内容、端末名、ホスト名、プロジェクト名、IP アドレス。grant に未知の項目があれば拒否し、保存する grant は読み取った項目だけから作り直します。

**ログ**: アクセスログは出しません。リレーが書く行は `listening`、`purged`、`closed` と、例外の種類（`error.code`）だけで、パス、メソッド、hostId、IP は含みません。Caddy も、`log` を書かないので、アクセスログは出ません（`src/ops.test.ts` が CI で検査します）。ただし Caddy のエラーログ（ERROR）には、TLS の失敗などで接続元が出ることがあります。compose の例は、そのログを 1 MiB の 1 ファイルで回します。残したくなければ `logging: driver: none` にしてください。

## 指標

`GET /metrics`（ローカルからだけ）が JSON を返します。転送のヘッダー（`X-Forwarded-For`、`Forwarded`、`X-Real-IP`）が付いたリクエストには 404 を返します。Caddyfile も `/metrics` を 404 にしています。

同時セッション数（と最大）、WebSocket の数、RSS と RSS の p95、CPU と CPU の p95、帯域（Mbps と p95）、送信待ちのバイト数、`bufferedAmount` の最大値、一時停止と切断の回数、切断の理由の内訳（`peer-closed`、`auth-failed`、`auth-timeout`、`setup-timeout`、`host-offline`、`backpressure`、`limit`、`replaced`、`revoked`、`ping-timeout`、`oversize`、`shutdown`、`error`、`normal`）。1 秒ごとに標本を取り、直近 5 分の p95 を出します。

## プロトコル

署名の入力はすべて `lp(ラベル) ‖ lp(部品)…` です。`lp` は、長さを u32 ビッグエンディアンで前置きします。文字列は UTF-8、nonce は生のバイト列です。鍵と署名は、パディングなしの base64url で送ります。

- `hostId = base32小文字(sha256(Hk))` の先頭 32 文字
- `deviceId = base32小文字(sha256(lp(alg) ‖ lp(Dk)))` の先頭 32 文字
- Ed25519: 鍵 32 バイト、署名 64 バイト。P-256: 鍵は非圧縮の 65 バイト（X9.63）、署名は r‖s の 64 バイト（P1363）。DER は使わない。

### HTTP

| メソッド | パス                         | 内容                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/health`                    | `{"ok":true}`。数は返さない                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET`    | `/.well-known/k3-relay`      | git のコミット、イメージのダイジェスト、スキーマのハッシュ、上限値                                                                                                                                                                                                                                                                                                                                                       |
| `POST`   | `/v1/hosts`                  | 登録。1 回目は `{hk}` を送ると `428` と課題 `{ts, difficulty, salt, mac}` が返る。2 回目は `{hk, challenge, nonce, sig, invite?}`。新規は `201`、登録済みは `200`。`sha256(lp("k3relay-v1/pow") ‖ lp(Hk) ‖ lp(mac の文字列) ‖ lp(nonce のバイト列))` の先頭のゼロが `difficulty` ビット以上で、`sig` は `Hk` による `k3relay-v1/register`、`Hk`、`mac`、`nonce`（送った文字列のまま）への署名。課題は有効 5 分、一回限り |
| `POST`   | `/v1/grants/revoke`          | `{hostId, deviceId, issuedAt, sig}`。`sig` は `Hk` による `k3relay-v1/revoke`、hostId、deviceId、`issuedAt`（10 進の文字列）への署名。`issuedAt` は現在から 5 分以内                                                                                                                                                                                                                                                     |
| `POST`   | `/v1/client/<hostId>/status` | `{alg, dk, grant, ts, nonce, sig}`。`sig` は `Dk` による `k3relay-v1/status`、hostId、deviceId、`ts`（10 進の文字列）、`nonce`（文字列）への署名。`ts` は ±60 秒、nonce は一回限り                                                                                                                                                                                                                                       |

`status` は、未知の hostId、署名の誤り、grant の誤り、古い時刻、nonce の再利用のすべてに、同じ `401 {"error":"unauthorized"}` を返します（未知のホストでも、署名の確認に同じ手間をかけます）。署名と grant が正しい端末にだけ、`403 revoked`、`403 grant-expired`、`200 {online, month:{bytes, limit}}` を返します。

### WebSocket

接続したら、リレーが `{"type":"nonce","nonce":"<32 バイト>"}` を送ります。5 秒以内に返事がなければ閉じます。認証前の 1 メッセージは 4 KiB までです。

- `WS /v1/host/control`: ホストが `{"type":"auth","hostId","sig"}` を返す（`sig` は `k3relay-v1/host-control`、hostId、nonce）。通れば `{"type":"ready"}`。同じ hostId の古い control は `4409` で閉じる。
  - ホスト → リレー: `{"type":"pairing-open","expiresAt"}`、`{"type":"pairing-close"}`、`{"type":"grant-register","grant","dk"}`、`{"type":"revoke","deviceId","issuedAt","sig"}`。
  - リレー → ホスト: `{"type":"session-open","sessionId","token","kind":"client"|"pairing","deviceId"?}`、`{"type":"error","code"}`。`deviceId` はリレーが見た値で、ホストは信じず、E2E の中の `Dk` から決める。
- `WS /v1/host/data/<sessionId>?t=<token>`: token は 16 バイトの一回限り、有効 10 秒。誤りは、アップグレードの前に `401`。
- `WS /v1/client/<hostId>`: 端末が `{"type":"auth","alg","dk","grant","sig"}` を返す。`sig` は `Dk` による `k3relay-v1/client`、hostId、deviceId、nonce。通れば、リレーが `{"type":"accepted"}` を 1 回だけ送り、ホストの data が張られたところから、2 本をそのまま（テキストはテキスト、バイナリはバイナリのまま）つなぐ。以降のフレームは、すべて E2E のものです。10 秒で張られなければ閉じる。
- `WS /v1/client/<hostId>?pairing=1`: 認証なし。ホストが窓を開けているときだけ（そうでなければ、未知のホストと同じ `404`）。ホストごとに同時 1、1 時間 10 回、1 つの接続は最長 5 分。

grant は `{v:1, hostId, deviceId, alg, issuedAt, expiresAt, nonce, sig}` だけです（名前や権限は入れられない）。`sig` は `Hk` による `k3relay-v1/grant`、`"1"`、hostId、deviceId、alg、`issuedAt`、`expiresAt`（10 進の文字列）、nonce への署名です。失効は「失効の時刻 ≥ grant の `issuedAt`」で判定するので、再ペアリングで出し直した新しい grant は通ります。

閉じるときの番号（`4xxx` はリレー独自）: `4400` 形式の誤り、`4401` 認証の失敗（未知のホスト、署名、grant、deviceId の不一致など、すべて同じ）、`4403` 失効（署名が通った端末にだけ）、`4404` ホストがオフライン（同上）、`4408` 時間切れ、`4409` 同じホストの新しい control に置き換えられた、`4410` grant の期限切れ（署名が通った端末にだけ）、`4423` 遮断、`4429` 上限、`1009` メッセージが大きすぎる、`1013` 送信先が詰まっている。片方が閉じたときは、もう片方を同じ番号で閉じます。

## 上限と公平配分

- 認証前の `maxPayload` は 4 KiB、認証後は 1 MiB（control は 64 KiB）。`perMessageDeflate` は無効。`ws` は `maxPayload` を作成時に 1 回しか受け取らないので、認証が通った接続について、内部の `_receiver._maxPayload` を上げています（変わったら接続を切り、テストが検出します）。
- バックプレッシャー: 送り先の `bufferedAmount` と、公平配分の待ちの合計が 1 MiB を超えたら、送り元の `ws` を一時停止し、10 秒解消しなければ切ります。全体の送信待ちの予算（既定 200 MiB）も超えたら、**自分の待ちが 64 KiB を超えている接続だけ**を止めます（静かな接続は、他人の洪水に巻き込まない）。
- 帯域: 全体のトークンバケット（既定 45 Mbps）の前に、ホスト → セッションの 2 段の DRR を置きます。バケットに余裕があれば、誰も待たされません。足りなくなると、待っているホストに等分します（ホストが開くセッションの数には関係しません）。登録から 7 日未満のホストの重みは 0.5、月の転送量が上限を超えたホストは 0.25 倍です。
- 月の転送量は、リレーが中継したバイト数を、両方向の合計で、1 バイトにつき 1 回数えます。直結は通らないので数えません。

## セルフホストの手順

1. DNS の A / AAAA を、リレーを置くマシンへ向ける。80 と 443 を開ける。
2. `docker-compose.example.yml` と `Caddyfile` を置き、`RELAY_DOMAIN` を指定して `docker compose up -d --build`。
3. `https://<ドメイン>/health` が `{"ok":true}` を返すのを確かめる。
4. 自分だけで使うなら、compose の `REQUIRE_INVITE` を `"1"` にして、招待コードを作る: `docker compose exec relay node src/cli.ts invite`（コードは 1 回だけ表示され、DB にはハッシュだけが入る。有効 30 日）。
5. K3 の設定でリレーの URL を、このドメインに差し替える。
6. バックアップ: `sqlite3 /data/relay.sqlite ".backup /backup/relay.sqlite"`（稼働中でよい）。
7. 悪質なホストは、`BLOCKED_HOSTS` に hostId を入れて再起動すると、control が通らなくなる。
8. ビルドの照合: `/.well-known/k3-relay` の `gitCommit` と `schemaHash` を、手元でビルドしたものと比べる。

## 開発

```sh
cd infra/k3-relay
vp test run --config ../../vite.config.ts --dir .
vp run typecheck   # effect-tsgo tsrs --noEmit
```

テストは、同じプロセスの中で本物の WebSocket を張ります。ファイルごとの内容: `crypto`（Ed25519 と P-256 の相互運用、grant）、`pow`、`fair`（公平配分）、`limits`、`store`（保持期間）、`auth`、`splice`（スプライス、バックプレッシャー、セッションの上限）、`abuse`（認証前の上限、control、ペアリング）、`register`、`status`、`privacy`（DB のファイルのバイト列、全テーブル、ログに IP、端末名、通信内容、招待コードがないこと）、`ops`（Caddyfile と Dockerfile）。

## 実測（このリポジトリの開発機で。マイクロではない）

Apple Silicon の Mac、Node 22、同じマシンにクライアントを置いた値です。マイクロ（1/8 OCPU、1 GB）での実測は、まだです。

- 待機: RSS 94 MB。control 1500 本: 118 MB（1 本あたり約 16 KB）。さらにスプライス 200 本: 126 MB（1 本あたり約 40 KB）。
- 200 セッションが全力で送り続け、全体の帯域が 45 Mbps のとき: 予算 200 MiB でピーク RSS 385 MB、64 MiB で 273 MB（`--max-old-space-size=320`）。400 MB のメモリ制限には 64 MiB が安全なので、compose の例は 64 MiB にしています。
- 帯域を絞らないと、同じマシンの中で 11 Gbps ほど流れました（CPU の上限の目安にはなりません）。

## 仕様との差

- control の認証後の上限は 64 KiB（仕様は一律 1 MiB）。
- スプライスは WebSocket の「メッセージ」単位で、フレームの細部（断片の区切り）は保たれません。中身は解釈しません。
- 端末の接続が通った直後に、リレー発の `{"type":"accepted"}` を 1 回送ります（仕様にはない。端末が「リレーは通った、ホスト待ち」を知るため）。
- `grants` テーブルは、ホストが control で送る `grant-register` で埋めます（仕様の §8-6 の「リレーに grant を渡す」の通り道）。入場の判断は、保存された grant ではなく、grant 自体の署名で行います。
- `usage` テーブル（月の転送量）を足しました。§10 の一覧に足す必要があります。
- grant の「正規形」は、JSON ではなく、固定の順序の長さ前置きの連結にしました。E2E の層（別タスク）と合わせる必要があります。
- 月の転送量は、優先度（重み）を下げるところまでです。全体の 70% / 90% での警報と縮退運転は、未実装です。
- 公平配分の階層は 2 段（ホスト、セッション）で、アカウントや IP の枠はありません。新しいホストの重みは「7 日未満で 0.5」の 2 段階だけです。
- PoW の課題は、`POST /v1/hosts` に `challenge` なしで送ると `428` で返ります（別のエンドポイントは作っていません）。
- `/metrics` は JSON です（Prometheus の形式ではありません）。
- 未実装: push（P4）、アカウント（P3.5）、OCI へのバックアップの定期実行、ビルドの出所の証明。
