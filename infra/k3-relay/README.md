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
| `EGRESS_BUDGET_BYTES`                                                | `10000000000000`     | リレー全体の月の送信量の予算（OCI の無料の送信量、10 TB）。中継したバイト数を、この予算に対して数える                           |
| `EGRESS_WARN_FRACTION` / `EGRESS_DEGRADED_FRACTION`                  | `0.7` / `0.9`        | 警報と、優先度の低いホストの絞り込みを始める割合 / 縮退運転を始める割合                                                         |
| `DEGRADED_HOST_MBPS`                                                 | `1`                  | 縮退運転中に、月の転送量の上限を超えたホストへかける 1 ホストあたりの上限                                                       |
| `PRESSURE_WEIGHT_FACTOR`                                             | `0.5`                | 警報の段階から、すでに重みが 1 未満のホスト（新しいホスト、上限超え）の重みにかける倍率                                         |
| `TRAFFIC_CHECK_MS` / `BLOCKED_POLL_MS`                               | `5000` / `5000`      | 全体の転送量の確認の間隔 / 遮断の一覧を DB から読み直す間隔                                                                     |
| `K3_ALERT_WEBHOOK_URL`                                               | なし                 | 警報の送り先（https のみ。手元の確認用に、127.0.0.1 などへの http は許す）。送るのは件名と数字だけ                              |
| `K3_SELF_PING_URL` / `K3_SELF_PING_INTERVAL_SEC`                     | なし / `0`（オフ）   | リレー自身の公開 URL（`https://<ドメイン>/health`）へ、この秒数ごとに軽い GET を送る（アイドル回収への備え。下を参照）          |
| `GIT_COMMIT` / `IMAGE_DIGEST`                                        | `unknown`            | `/.well-known/k3-relay` に出す。`GIT_COMMIT` はビルド引数、`IMAGE_DIGEST` は配備のときに渡す                                    |

アカウント（GitHub / Google / Apple でのサインイン）の変数（`RELAY_PUBLIC_URL`、`ACCOUNT_TOKEN_SEED`、`ACCOUNT_ID_HMAC_KEY`、提供元ごとの ID と秘密など）は、[docs/ACCOUNTS.md](docs/ACCOUNTS.md) にまとめています。**どの提供元も設定しなければ、アカウントは無効で、その API はすべて `404` です。**

上限値の一覧は、実行中のリレーの `/.well-known/k3-relay` にも出ます。

## 保存するデータ

SQLite（`node:sqlite`）に、次の 9 つだけを置きます（スキーマは `src/store.ts` の `SCHEMA_SQL`。ハッシュは `/.well-known/k3-relay` の `schemaHash`）。

| テーブル        | 内容                                                                      | 保持                                 |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| `hosts`         | hostId、`Hk`、登録日、最終接続日（日単位）                                | 365 日接続がなければ削除             |
| `grants`        | hostId、deviceId、`Dk`、`alg`、grant（名前なし）、期限                    | 期限から 30 日、または失効から 30 日 |
| `revocations`   | hostId、deviceId、失効の時刻、署名                                        | 30 日                                |
| `invites`       | コードのハッシュ、使用済みの印、期限（`REQUIRE_INVITE=1` のときだけ使う） | 使用後 30 日                         |
| `usage`         | hostId、月、中継したバイト数                                              | 2 か月                               |
| `blocked_hosts` | 運営が遮断した hostId と、遮断した時刻（理由や IP は持たない）            | `unblock` するまで                   |
| `accounts`      | ランダムなアカウント ID、作成日（アカウントを使う人だけ）                 | アカウントの削除まで                 |
| `identities`    | 提供元、識別子（GitHub の数値 ID、OIDC の `sub`）の HMAC、アカウント ID   | アカウントの削除まで                 |
| `account_hosts` | アカウント ID、hostId                                                     | 一覧から外すか、アカウントの削除まで |

メモリだけに置くもの: nonce、セッション、token、ペアリングの窓、IP ごとの数（IP は保存しない）、指標。

**保存しない**: 通信内容、端末名、ホスト名、プロジェクト名、IP アドレス、メールアドレス、氏名、アバター、ログイン名、提供元のトークン。grant に未知の項目があれば拒否し、保存する grant は読み取った項目だけから作り直します。

**ログ**: アクセスログは出しません。リレーが書く行は `listening`、`purged`、`closed`、全体の転送量の警報（`alert`。しきい値と数字だけ）、自己通信の失敗と回復（`self-ping-failed`、`self-ping-recovered`）、警報 webhook の失敗（`alert-webhook-failed`）と、例外の種類（`error.code`）だけで、パス、メソッド、hostId、IP、URL は含みません。Caddy も、`log` を書かないので、アクセスログは出ません（`src/ops.test.ts` が CI で検査します）。ただし Caddy のエラーログ（ERROR）には、TLS の失敗などで接続元が出ることがあります。compose の例は、そのログを 1 MiB の 1 ファイルで回します。残したくなければ `logging: driver: none` にしてください。

## 指標

`GET /metrics`（ローカルからだけ）が JSON を返します。転送のヘッダー（`X-Forwarded-For`、`Forwarded`、`X-Real-IP`）が付いたリクエストには 404 を返します。Caddyfile も `/metrics` を 404 にしています。

同時セッション数（と最大）、WebSocket の数、RSS と RSS の p95、CPU と CPU の p95、送信の帯域（書き込みが終わったバイト数から。Mbps と p95）、送信待ちのバイト数、`bufferedAmount` の最大値（起動からの最大 `maxBufferedAmount` と、直近 5 分の最大 `maxBufferedAmountRecent`）、一時停止と切断の回数、切断の理由の内訳（`peer-closed`、`auth-failed`、`auth-timeout`、`setup-timeout`、`host-offline`、`backpressure`、`limit`、`degraded`、`blocked`、`replaced`、`revoked`、`ping-timeout`、`oversize`、`shutdown`、`error`、`normal`）、全体の月の転送量（`traffic`: 月、バイト数、予算、割合、`level`）、自己通信の回数（`selfPing`）。1 秒ごとに標本を取り、直近 5 分の p95 を出します。

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

アカウント（[docs/ACCOUNTS.md](docs/ACCOUNTS.md)。提供元が 1 つも設定されていなければ、すべて `404`）:

| メソッド | パス                                    | 内容                                                                                                                                            |
| -------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/v1/account/providers`                 | 有効な提供元 `{providers}`                                                                                                                      |
| `POST`   | `/v1/account/oauth/<provider>/start`    | `{use: "device"\|"host", alg, key, challenge, redirect, state}` → `{authorizeUrl}`                                                              |
| `GET`    | `/v1/account/oauth/<provider>/callback` | 提供元からの戻り。`302` でアプリの戻り先へ `?code=<K3 のコード>&state=<アプリの state>`。失敗はすべて同じ `400`                                 |
| `POST`   | `/v1/account/token`                     | `{code, verifier, redirect, ts, sig}` → `{token, expiresAt, use}`。`sig` は結びついた鍵による `k3relay-v1/account-code`、code、`ts`             |
| `POST`   | `/v1/account/hosts`                     | 端末だけ。`{hosts: [{hostId, hk}]}`                                                                                                             |
| `POST`   | `/v1/account/hosts/add`                 | ホストだけ（登録済みのホスト）。自分をアカウントに載せる                                                                                        |
| `POST`   | `/v1/account/hosts/remove`              | `hostId`。端末は自分のアカウントの任意のホストを、ホストは自分だけを外す                                                                        |
| `POST`   | `/v1/account/hosts/token`               | 端末だけ。`hostId, dalg, dk, dsig` → 5 分のチケット。`dsig` は新しい鍵 `dk` による `k3relay-v1/account-bind`、hostId、セッションの鍵の deviceId |
| `POST`   | `/v1/account/delete`                    | アカウントと、その識別子とホストの一覧を消す                                                                                                    |

アカウントの呼び出しの本文は、すべて `{token, alg, key, ts, nonce, sig, …引数}` で、`sig` は `key`（トークンが結びついた鍵）による `k3relay-v1/account-request`、パス、トークン、`ts`、nonce、引数（順に）への署名です。`ts` は ±60 秒、nonce は一回限り。

`status` は、未知の hostId、署名の誤り、grant の誤り、古い時刻、nonce の再利用のすべてに、同じ `401 {"error":"unauthorized"}` を返します（未知のホストでも、署名の確認に同じ手間をかけます）。署名と grant が正しい端末にだけ、`403 revoked`、`403 grant-expired`、`200 {online, month:{bytes, limit}}` を返します。

### WebSocket

接続したら、リレーが `{"type":"nonce","nonce":"<32 バイト>"}` を送ります。5 秒以内に返事がなければ閉じます。認証前の 1 メッセージは 4 KiB までです。

- `WS /v1/host/control`: ホストが `{"type":"auth","hostId","sig"}` を返す（`sig` は `k3relay-v1/host-control`、hostId、nonce）。通れば `{"type":"ready"}`。同じ hostId の古い control は `4409` で閉じる。
  - ホスト → リレー: `{"type":"pairing-open","expiresAt"}`、`{"type":"pairing-close"}`、`{"type":"grant-register","grant","dk"}`、`{"type":"revoke","deviceId","issuedAt","sig"}`。
  - リレー → ホスト: `{"type":"session-open","sessionId","token","kind":"client"|"pairing","deviceId"?}`、`{"type":"error","code"}`。`deviceId` はリレーが見た値で、ホストは信じず、E2E の中の `Dk` から決める。
- `WS /v1/host/data/<sessionId>?t=<token>`: token は 16 バイトの一回限り、有効 10 秒。誤りは、アップグレードの前に `401`。
- `WS /v1/client/<hostId>`: 端末が `{"type":"auth","alg","dk","grant","sig"}` を返す。`sig` は `Dk` による `k3relay-v1/client`、hostId、deviceId、nonce。通れば、リレーが `{"type":"accepted"}` を 1 回だけ送り、ホストの data が張られたところから、2 本をそのまま（テキストはテキスト、バイナリはバイナリのまま）つなぐ。以降のフレームは、すべて E2E のものです。10 秒で張られなければ閉じる。
- `WS /v1/client/<hostId>?account=1`: アカウント経由のノック（アカウントが無効なら `404`）。端末が `{"type":"auth","alg","dk","token","sig"}` を返す（`token` は `/v1/account/hosts/token` のチケット、`sig` は `Dk` による `k3relay-v1/account-client`、hostId、deviceId、nonce）。通れば、ペアリングと同じ匿名の E2E のセッション（`session-open` の `kind` は `account`）になり、ホストが、チケットを自分で検証して、利用者の承認を求める。ホストごとに 1 時間 20 回、同時 2 本、1 つの接続は最長 11 分。
- `WS /v1/client/<hostId>?pairing=1`: 認証なし。ホストが窓を開けているときだけ（そうでなければ、未知のホストと同じ `404`）。ホストごとに同時 1、1 時間 10 回、1 つの接続は最長 5 分。

grant は `{v:1, hostId, deviceId, alg, issuedAt, expiresAt, nonce, sig}` だけです（名前や権限は入れられない）。`sig` は `Hk` による `k3relay-v1/grant`、`"1"`、hostId、deviceId、alg、`issuedAt`、`expiresAt`（10 進の文字列）、nonce への署名です。失効は「失効の時刻 ≥ grant の `issuedAt`」で判定するので、再ペアリングで出し直した新しい grant は通ります。

閉じるときの番号（`4xxx` はリレー独自）: `4400` 形式の誤り、`4401` 認証の失敗（未知のホスト、署名、grant、deviceId の不一致など、すべて同じ）、`4403` 失効（署名が通った端末にだけ）、`4404` ホストがオフライン（同上）、`4408` 時間切れ、`4409` 同じホストの新しい control に置き換えられた、`4410` grant の期限切れ（署名が通った端末にだけ）、`4423` 遮断（運営が止めたホスト。ホストの control と、そのホストのセッション、端末の接続のすべて）、`4429` 上限（理由の文字列が `degraded` のときは、リレー全体の転送量が多いための縮退運転で、新しいセッションだけを断っている。画面には「リレーの転送量が多いため、絞っています。LAN や VPN での接続は、影響を受けません」と出す）、`1009` メッセージが大きすぎる、`1013` 送信先が詰まっている。片方が閉じたときは、もう片方を同じ番号で閉じます。

## 上限と公平配分

- 認証前の `maxPayload` は 4 KiB、認証後は 1 MiB（control は 64 KiB）。`perMessageDeflate` は無効。`ws` は `maxPayload` を作成時に 1 回しか受け取らないので、認証が通った接続について、内部の `_receiver._maxPayload` を上げています（変わったら接続を切り、テストが検出します）。
- バックプレッシャー: 送り先の `bufferedAmount` と、公平配分の待ちの合計が 1 MiB を超えたら、送り元の `ws` を一時停止し、10 秒解消しなければ切ります。全体の送信待ちの予算（既定 200 MiB）も超えたら、**自分の待ちが 64 KiB を超えている接続だけ**を止めます（静かな接続は、他人の洪水に巻き込まない）。
- 帯域: 全体のトークンバケット（既定 45 Mbps）の前に、ホスト → セッションの 2 段の DRR を置きます。バケットに余裕があれば、誰も待たされません。足りなくなると、待っているホストに等分します（ホストが開くセッションの数には関係しません）。登録から 7 日未満のホストの重みは 0.5、月の転送量が上限を超えたホストは 0.25 倍です。
- 月の転送量は、リレーが中継したバイト数を、両方向の合計で、1 バイトにつき 1 回数えます。直結は通らないので数えません。

### 月の転送量（全体）

ホストごとの 200 GB（`MONTHLY_QUOTA_BYTES`）は、重みを下げるだけです。リレー全体の送信量は別に、OCI の無料枠（月 10 TB、`EGRESS_BUDGET_BYTES`）に対して数えます。数えるのは中継したバイト数で、毎月 1 日（UTC）に 0 から始め、`usage` テーブルの合計から読み戻すので、再起動で忘れません（最後の flush から落ちるまでの最大 30 秒分は失う）。

| 割合       | 起きること                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 70% 未満   | 何もしない（公平配分だけ）                                                                                                                                                                                                                             |
| 70% 以上   | 警報を 1 回（標準出力に 1 行、`/metrics` の `traffic.level` が `warn`、`K3_ALERT_WEBHOOK_URL` があれば POST）。重みが 1 未満のホスト（登録から 7 日未満、月の上限超え）の重みを `PRESSURE_WEIGHT_FACTOR`（0.5）倍にする。重みが 1 のホストには触れない |
| 90% 以上   | 2 回目の警報。**重みが 1 未満のホストは、新しいセッションを開けない**（4429、理由 `degraded`）。すでにつながっているセッションは続く。月の上限（200 GB）を超えたホストには、1 ホストあたり `DEGRADED_HOST_MBPS`（1 Mbps）の上限をかける                |
| 月が替わる | 計数と警報の状態が 0 に戻り、縮退も解ける                                                                                                                                                                                                              |

- 警報の送り先 `K3_ALERT_WEBHOOK_URL` に送る本文は、件名と数字だけです（`subject`、`text`、`level`、`thresholdPercent`、`percent`、`usedBytes`、`budgetBytes`、`month`）。hostId も IP も入りません（テストが検査します）。
- 警報は、月ごと、しきい値ごとに 1 回です。再起動のたびに、その時点で超えていれば、もう一度出ます（取りこぼしより、重複のほうがましと判断しました）。
- 端末は `status` の答えの `state`（`ok`、`squeezed`、`blocked`）で、画面に出す理由を決められます。

## セルフホストの手順

1. DNS の A / AAAA を、リレーを置くマシンへ向ける。80 と 443 を開ける。
2. `docker-compose.example.yml` と `Caddyfile` を置き、`RELAY_DOMAIN` を指定して `docker compose up -d --build`。
3. `https://<ドメイン>/health` が `{"ok":true}` を返すのを確かめる。
4. 自分だけで使うなら、compose の `REQUIRE_INVITE` を `"1"` にして、招待コードを作る: `docker compose exec relay node src/cli.ts invite`（コードは 1 回だけ表示され、DB にはハッシュだけが入る。有効 30 日）。
5. K3 の設定でリレーの URL を、このドメインに差し替える。
6. バックアップ: `node src/cli.ts backup <新しいファイル>`（稼働中でよい。下の「バックアップと復元」）。
7. 悪質なホストは、`node src/cli.ts block <hostId>`（下の「運営の操作」）。`BLOCKED_HOSTS` に入れて再起動する方法も使える。
8. ビルドの照合: `/.well-known/k3-relay` の `gitCommit` と `schemaHash` を、手元でビルドしたものと比べる。

## 運営の操作

どれも、リレーのコンテナの中で（`docker compose exec relay node src/cli.ts …`、本番の形では `deploy/compose.sh exec -T relay node src/cli.ts …`）。DB を直接読み書きするので、動いているリレーに知らせる手間は要りません。

| コマンド            | 内容                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `block <hostId>`    | そのホストを遮断する。動いているリレーが 5 秒以内（`BLOCKED_POLL_MS`）に、control と全セッションを `4423` で閉じ、以後の control、端末の接続、ペアリングを断る。遮断は `blocked_hosts` に残り、再起動をまたぐ |
| `unblock <hostId>`  | 遮断を解く。ホストは自分で再接続する                                                                                                                                                                          |
| `blocked`           | 遮断中の hostId の一覧                                                                                                                                                                                        |
| `backup <ファイル>` | 一貫した DB のスナップショットを、新しいファイルに作る                                                                                                                                                        |
| `invite`            | 招待コードを作る（`REQUIRE_INVITE=1` のとき）                                                                                                                                                                 |

IP は、ホストの登録の 1 日あたりの上限（`REGISTRATIONS_PER_IP_PER_DAY`、IPv6 は /64）を数えるためだけに、メモリの中で持ち、保存も、ログへの出力もしません。再起動で消えます。

## バックアップと復元

**取り方**: `node src/cli.ts backup <ファイル>` は `VACUUM INTO` で、稼働中のまま、一貫した 1 ファイル（0600）を作り、SQLite の `integrity_check` に通してから終わります。既存のファイルは上書きしません。

**毎晩の自動化**（OCI の無料のオブジェクトストレージ）: `deploy/backup.sh` を、systemd の timer（`deploy/systemd/k3-relay-backup.timer`。毎日 18:30 UTC = 日本時間 03:30。取りこぼしは起動後に補う）が動かします。コンテナの中で `backup` を実行し、gzip にして、`oci os object put` でバケットに置き、**新しい 14 世代**だけを残します（`BACKUP_KEEP`。消すのは、このスクリプトが作る名前 `relay/relay-<UTC の日時>.sqlite.gz` だけで、アップロードが成功した後だけ）。失敗すると、`K3_ALERT_WEBHOOK_URL` に件名と終了コードだけを送ります。`backup.sh --dry-run` は、何も変えずに手順を表示します。

`oci` は、インスタンス自身の権限（instance principal）でサインインします。次を一度、作っておく必要があります（`oci-provision.sh` の終わりにも表示されます。このスクリプトは作りません）:

```
動的グループ <name>-instances: ALL {instance.compartment.id = '<K3 のコンパートメントの OCID>'}
ポリシー:
  Allow dynamic-group <name>-instances to manage objects in compartment <name> where target.bucket.name = '<バケット>'
  Allow dynamic-group <name>-instances to read buckets in compartment <name>
  Allow dynamic-group <name>-instances to read objectstorage-namespaces in tenancy
```

バックアップには、`hosts`（公開鍵）、`grants`（署名済みの grant、名前なし）、`revocations`、`usage`、`blocked_hosts` が入ります。通信内容、端末名、IP、PoW の署名鍵は入りません（`privacy` のテストが、DB に入るものを検査しています）。

**復元の手順**（リレーのマシンで。復元した時点以降の登録、失効、遮断、転送量は戻らないので、直近の遮断は `blocked` で見直してください）:

```sh
cd /opt/k3-relay/src/infra/k3-relay      # 本番の置き場。ほかの形なら compose のあるディレクトリ
export OCI_CLI_AUTH=instance_principal
BUCKET=<バケット>
# 1. 新しい世代を探して取る
NAME=$(oci os object list --bucket-name "$BUCKET" --prefix relay/ --all --query 'data[].name' | jq -r '.[]' | sort | tail -n 1)
oci os object get --bucket-name "$BUCKET" --name "$NAME" --file /tmp/restore.sqlite.gz
gunzip -f /tmp/restore.sqlite.gz
# 2. 中身を確かめる（"ok" と、ホスト数が出る）
sqlite3 /tmp/restore.sqlite 'PRAGMA integrity_check; SELECT COUNT(*) FROM hosts;'
# 3. リレーを止め、いまの DB を退避して、置き換える（/data は名前付きボリューム relay-data）
deploy/compose.sh stop relay
VOLUME=$(docker volume ls -q | grep relay-data | head -n 1)
docker run --rm -v "$VOLUME":/data -v /tmp:/restore alpine sh -c \
  'mkdir -p /data/before-restore && mv /data/relay.sqlite* /data/before-restore/ \
   && cp /restore/restore.sqlite /data/relay.sqlite && chown 1000:1000 /data/relay.sqlite'
# 4. 起動して、確かめる
deploy/compose.sh start relay
curl -fsS https://<ドメイン>/health
rm /tmp/restore.sqlite
```

手順 2 の `sqlite3` は、cloud-init が入れます。復元の練習は、本番の前に、一度やっておくことを勧めます（この手順は、まだ実際には動かしていません）。

## OCI への構築（`deploy/`）

仕様の §11 の構成（OCI の無料のマイクロ、Ubuntu 24.04 x86_64、1 GB）を、作り直せる形で置いています。**どれも、まだ実際には動かしていません**（構文だけを `bash -n` と `shellcheck` で確認し、`src/deploy.test.ts` が内容を検査しています）。

| ファイル                                            | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oci-provision.sh`                                  | `oci` CLI で、K3 専用のコンパートメント、VCN、サブネット、セキュリティリスト（80 と 443 は全員、22 は `--ssh-cidr` だけ）、マイクロのインスタンス、予約済みの公開 IP、バックアップのバケットを作る。**既定は `--dry-run`（何も作らず、コマンドを表示）。`--apply` を付けたときだけ作る。** 既存のものを削除も変更もしない（同じ名前のものは、そのまま使う。インスタンスと公開 IP は、あれば止まる）。作る前に、テナンシーの無料枠の残り（マイクロの台数、2 台まで）とホームリージョンを確認して表示する。DNS と IAM は作らず、必要な内容を表示する |
| `cloud-init.yaml`                                   | 初回起動の設定のひな形（`oci-provision.sh` が値を入れる）: Docker、ユーザー `k3`、ファイアウォール（iptables。80 と 443、22 は指定の範囲だけ）、スワップ 1 GB、自動のセキュリティ更新（再起動が要るときは 19:00 UTC）、リレーのデプロイ、バックアップの timer                                                                                                                                                                                                                                                                                      |
| `install.sh`                                        | マシンの上で、設定と systemd の unit を入れ、`docker compose` で起動する。何度でも実行でき、更新もこれ（`RELAY_IMAGE` があればイメージを取得、なければソースから作る）                                                                                                                                                                                                                                                                                                                                                                             |
| `compose.sh`                                        | 本番の形の `docker compose`（`docker-compose.example.yml` に `docker-compose.oci.yml` を重ねる）                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `backup.sh` + `systemd/k3-relay-backup.*`           | 毎晩のバックアップ（上）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `healthcheck.sh` + `systemd/k3-relay-healthcheck.*` | 外からの稼働確認                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `notify.sh`                                         | 警報の webhook への送信（件名と数字だけ。URL は表示しない）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

```sh
# 何が作られるかを見る（何も作らない）
deploy/oci-provision.sh --tenancy-ocid <OCID> --repo-url https://<リポジトリ> --repo-ref <コミットの SHA> \
  --ssh-cidr <自分の IPv4 の範囲> --ssh-public-key-file ~/.ssh/id_ed25519.pub
# 実際に作る
deploy/oci-provision.sh --apply …（同じ引数）
```

- マシンは、`--repo-ref` のコミットの `infra/k3-relay/` だけを取得して入れます。**完全なコミットの SHA を指定してください**（ブランチ名だと、起動した時点の先頭が入ります）。`--relay-image` に公開済みのイメージ（ダイジェスト指定を勧める）を渡すと、ビルドせずに取得します。
- `K3_ALERT_WEBHOOK_URL` を環境に置いて実行すると、ユーザーデータに入ります（OCI のコンソールで、そのインスタンスを読める人に見えます）。気になるなら、起動後に `/etc/k3-relay/relay.env` と `backup.env` に書いてください。
- DNS（`relay.k3.kinocode.jp` の A レコード、プロキシなし）は、スクリプトの最後に表示される公開 IP で、実行の直前に確認してから、手で作ります。名前が引けるようになると、Caddy が証明書を取ります。

### 稼働の確認と、アイドル回収への備え

- **外からの確認**: `deploy/healthcheck.sh` が、`/health` を取り、`{"ok":true}` 以外が 3 回続いたら（`K3_HEALTH_FAILS`）、一度だけ通知し、戻ったときにも通知します。リレーのマシンの外（別のマシン、定期実行の CI）で動かしてください。同じマシンでは、マシンが消えたことに気づけません。timer の unit は `--with-healthcheck` で入れられます。
- **自己通信**: `K3_SELF_PING_URL=https://<ドメイン>/health` と `K3_SELF_PING_INTERVAL_SEC=300` のように設定すると、リレーが自分の公開 URL へ軽い GET を送ります（中継した量には数えません）。**これだけで回収を防げる保証はありません**: OCI の判定は 7 日間の CPU などの 95 パーセンタイルで、1 回の GET では、ほとんど動かせません。実測の指標（CPU の p95 など）を見て、仕様のとおり、作り直せる手順（このディレクトリ）を保ち、負荷が増えたら ARM の有償に移ってください。
- 移行の判断に使う指標（`/metrics`）: `cpuPercentP95`、`rssP95Bytes`、`bandwidthMbpsP95`、`maxBufferedAmountRecent`、`disconnects`（目安は、CPU が持続して 60% 超、メモリ 700 MB 超、帯域の p95 が 35 Mbps 超）。

## 開発

```sh
cd infra/k3-relay
vp test run --config ../../vite.config.ts --dir .
vp run typecheck   # effect-tsgo tsrs --noEmit
```

テストは、同じプロセスの中で本物の WebSocket を張ります。ファイルごとの内容: `crypto`（Ed25519 と P-256 の相互運用、grant）、`pow`、`fair`（公平配分）、`limits`、`store`（保持期間）、`auth`、`splice`（スプライス、バックプレッシャー、セッションの上限）、`abuse`（認証前の上限、control、ペアリング）、`register`、`status`、`privacy`（DB のファイルのバイト列、全テーブル、ログに IP、端末名、通信内容、招待コードがないこと。IP ごとの登録数の上限が IPv6 の /64 でも数えられ、保存されないこと）、`ops`（Caddyfile と Dockerfile）、`traffic`（70% / 90% の警報、縮退運転、月の切り替わり、再起動をまたぐ計数、警報の本文に hostId と IP がないこと、1 ホストの上限）、`block`（遮断と解除）、`account`（OAuth の state、PKCE、コードの再利用、戻り先、ID トークンの署名と `aud` / `iss` / `exp` / nonce、GitHub の数値 ID、アカウントのトークンとノック。フェイクの提供元を同じプロセスに立てる）、`admin`（運営のコマンド）、`backup`（スナップショット）、`metrics`（実測の指標と自己通信）、`deploy`（`deploy/` の内容）。

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
- 月の転送量: 全体の予算（10 TB）に対する計数は、`usage` テーブルの合計から読み戻します（新しいテーブルや列はありません）。「リレーを通ったバイト数」をそのまま OCI の送信量と見なしていて、TLS と TCP のヘッダーの分は数えません（予算に余裕を持たせるため、`EGRESS_BUDGET_BYTES` を少し下げて使ってください）。
- 縮退運転（90% 以上）で新しいセッションを断るのは、基本の重みが 1 未満のホスト（登録から 7 日未満、または月の上限超え）です。仕様の「重みの低いホストから絞る」を、2 段（70% は重みを下げる、90% は新規を断る）にしました。100% 以上の段階は、作っていません（ハードな上限にしない、という §9 に従う）。
- 縮退運転で月の上限を超えたホストを絞る 1 Mbps は、ホストごとのトークンバケット（`src/throttle.ts`）で、公平配分の前に置いています。先頭のバーストは、約 1 秒分（最小 16 KiB）です。
- 警報は、再起動のたびに、超えていればもう一度出ます（警報の「済み」は、DB に持たない）。
- 公平配分の階層は 2 段（ホスト、セッション）で、アカウントや IP の枠はありません。新しいホストの重みは「7 日未満で 0.5」の 2 段階だけです。
- PoW の課題は、`POST /v1/hosts` に `challenge` なしで送ると `428` で返ります（別のエンドポイントは作っていません）。
- `/metrics` は JSON です（Prometheus の形式ではありません）。
- `blocked_hosts` テーブルを足しました（遮断の一覧。§10 の一覧に足す必要があります）。遮断した hostId を知っているのは運営だけで、端末の接続には、署名が通ったときだけ `4423` を返します。
- `status` の答えに `state`（`ok`、`squeezed`、`blocked`）を足しました。縮退運転と遮断の理由を、画面に出すためです。
- バックアップ、構築のスクリプト、cloud-init は、書いただけで、実際の OCI では動かしていません。オブジェクトストレージへの書き込みの権限（instance principal の動的グループとポリシー）は、手で作る必要があります。
- 自己通信は、アイドル回収を防ぐ保証になりません（上を参照）。
- アカウント（P3.5）の仕様との差は、[docs/ACCOUNTS.md](docs/ACCOUNTS.md) の末尾。デバイスコード（CLI のホスト）と、複数の提供元のひも付けは、まだ。
- 未実装: push（P4）、ビルドの出所の証明。
