# 通知（P4）: E2E で暗号化したプッシュ

仕様 v3.5 の §13（通知用の鍵 `Nk`）と §16 の P4 の実装です。リレーの運営者（Kinocode）も、APNs / FCM（Apple と Google）も、通知の中身を読めないようにしています。

## 誰が何を持つか

| 当事者     | 持つもの                                                                       | 持たないもの                     |
| ---------- | ------------------------------------------------------------------------------ | -------------------------------- |
| 端末       | `Nk` の秘密鍵（ホストごとに 1 つ）、プッシュのトークン                         | —                                |
| ホスト     | 端末ごとの `Nk` の公開鍵と、通知の設定（E2E の内側で受け取る）                 | プッシュのトークン               |
| リレー     | hostId・deviceId・プッシュのトークンの対応表（`push_targets`）、一時的に暗号文 | `Nk`、通知の中身、端末と人の対応 |
| APNs / FCM | トークン、暗号文、iOS では固定の文言（「K3 Code / New activity」）             | 通知の中身                       |

- 端末は、`Nk`（X25519）を**ホストごとに**作り、公開鍵だけを、E2E のチャネルの内側（多重化の HTTP、`POST /api/relay/notify`）で、ホストに渡します。ホストは、セッションの端末だけを登録先にします（本文の端末 ID は使いません）。ホストごとに分けるのは、1 つの鍵を複数のホストで共有すると、あるホストが、別のホストを名乗る通知を作れてしまうからです（HPKE の base モードは、送り手を証明しません）。
- 端末は、プッシュのトークンを、`Nk` とは別に、リレーに登録します（`POST /v1/client/<hostId>/push`。`Dk` の署名と、有効な grant が必要）。ホストはトークンを知らず、リレーは `Nk` を知りません。
- ホストは、通知を端末ごとに `Nk` へ暗号化し、`Hk` で署名して、リレーに渡します（`POST /v1/push/send`）。リレーは、署名したホストの hostId の下でだけ、端末のトークンを探します。ほかのホストの端末には届きません。

## 暗号

HPKE（RFC 9180）の base モード、DHKEM(X25519, HKDF-SHA256)、HKDF-SHA256、ChaCha20-Poly1305（iOS の CryptoKit の `Curve25519_SHA256_ChachaPoly`）。実装は `packages/shared/src/notify/`（RFC 9180 の A.2.1 のテストベクタで検証）。

```
envelope  = version (1 バイト, 0x01) ‖ keyId (8) ‖ enc (32) ‖ 暗号文
keyId     = sha256("k3relay-v1/notify-key-id" ‖ Nk の公開鍵) の先頭 8 バイト
info      = "k3relay-v1/notify"
aad       = version ‖ keyId
平文      = u16be(JSON の長さ) ‖ JSON ‖ 0 埋め（256、512、1024 バイトのどれかに揃える）
JSON      = {"v":1,"id":<16 バイトの乱数, base64url>,"ts":<ミリ秒>,"kind":<種類>,"env":<環境 ID>,"thread"?:<スレッド ID>,"text"?:<120 文字まで>}
種類      = approval | input | completed | failed | test | device（紹介で端末が加わった。端末の設定によらず送る）
```

最大の envelope は 1081 バイト（base64url で 1442 文字）で、APNs と FCM の 4 KB に収まります。リレーは `PUSH_MAX_ENVELOPE_BYTES`（既定 2048）を超えるものを `413` で断ります。iOS の通知拡張（Swift）と Android の受信サービス（Kotlin）は、この形をそのまま読みます。形を変えるときは、`version` を上げてください。

## 中身を最小限にする

- **タイトルを持ちません。** スレッドの題名、プロジェクト名、ホスト名、コマンド、ファイル名は入れません。端末は、`kind` から文言を作り、ホスト名は、手元の記録（ペアリングのときに覚えた名前）から出します。
- `text` は、短い断片を入れるための欄ですが、ホストは今のところ使いません。
- 0 埋めで、長さを 3 段階に揃えます。

## 前方秘匿性がないこと

通知には、**前方秘匿性がありません。** HPKE の base モードは、送るたびに新しい一時鍵を使いますが、受け手の鍵 `Nk` は長く使います。`Nk` の秘密鍵が漏れると、それまでに記録された通知の暗号文（APNs / FCM や、経路の途中で保存されたもの）を、すべて読めてしまいます。

- そのため、中身を最小限にしています（上）。漏れても、「いつ、どのスレッドで、承認待ちになったか」までです。
- `Nk` が漏れても、端末のなりすまし（`Dk` が要る）や、ホストへの接続はできません。
- 端末は、ペアリングをし直すと、新しい `Nk` を作ります。端末を失効させると、ホストは、その端末の `Nk` を捨てます。

## 再送と古い通知

- 1 通ごとに、新しい一時鍵（`enc`）と、乱数の `id` を使います。同じ `enc` が 2 度来ても、復号はできますが、端末は、同じ `id` を 2 度は出しません（アプリの中。iOS の拡張と Android のサービスは、`id` を覚えず、時刻だけを見ます）。
- 24 時間より古い通知と、5 分より先の時刻の通知は、捨てます。リレーが暗号文を取っておいて、あとで送り直しても、出ません。
- 改ざんは、AEAD（ChaCha20-Poly1305）と、AAD に含めた見出し（版と keyId）で、すべて見つかります。

## リレーの API

| メソッド | パス                              | 署名        | 内容                                                                                                                                                                                                                                                              |
| -------- | --------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/v1/client/<hostId>/push`        | `Dk`、grant | `{alg, dk, grant, ts, nonce, platform, token, sig}`。`sig` は `k3relay-v1/push-register`、hostId、deviceId、`ts`、`nonce`、`platform`、`token` への署名。`200`、`401`（一律）、`403`（`revoked` / `grant-expired` / `blocked`）、`429`、`503`（その OS が未設定） |
| `POST`   | `/v1/client/<hostId>/push/remove` | `Dk`、grant | `{alg, dk, grant, ts, nonce, sig}`。`k3relay-v1/push-remove`、hostId、deviceId、`ts`、`nonce`。失効・期限切れの端末でも外せる                                                                                                                                     |
| `POST`   | `/v1/push/send`                   | `Hk`        | `{hostId, deviceId, ts, nonce, envelope, sig}`。`k3relay-v1/push-send`、hostId、deviceId、`ts`、`nonce`、envelope のバイト列。`200`、`401`、`404 no-target`、`410 gone`（トークンを削除した）、`413`、`429`、`502 upstream`、`503`                                |

- `platform` は `ios`、`ios-sandbox`（開発用の署名のアプリ）、`android`。
- `ts` は、リレーの時刻から 60 秒以内。`nonce` は一回限り。
- APNs にも FCM にも資格情報がなければ、これらの API はすべて `404` です。`/.well-known/k3-relay` の `push.platforms` に、使える OS が出ます。
- 上限: ホストごと 1 分 60 通、端末ごと 1 分 10 通、登録は端末ごと 1 分 6 回、1 ホストのトークン 64 個（`PUSH_PER_MINUTE_PER_HOST`、`PUSH_PER_MINUTE_PER_DEVICE`、`PUSH_REGISTRATIONS_PER_MINUTE_PER_DEVICE`、`MAX_PUSH_TARGETS_PER_HOST`）。
- 失効（`revoke`）が届くと、その端末のトークンを、すぐに消します。APNs の `410` と `400 BadDeviceToken` / `DeviceTokenNotForTopic`、FCM の `UNREGISTERED` でも消します。90 日使われなければ消します（`PUSH_TARGET_IDLE_DAYS`）。

## APNs と FCM への渡し方

- APNs: HTTP/2、`.p8` の鍵による ES256 のプロバイダートークン（50 分ごとに作り直す）。`apns-push-type: alert`、`mutable-content: 1`、本文は固定の「K3 Code / New activity」と、`k3`（envelope の base64url）。通知拡張が、`k3` を開いて、文言を差し替えます。拡張が開けないときだけ、固定の文言が出ます。
- FCM: HTTP v1、サービスアカウントの JWT（RS256）で OAuth2 のアクセストークンを取り（期限の 1 分前まで使い回す）、**data だけ**のメッセージ（`data.k3`、`priority: high`）を送ります。アプリの受信サービスが開いて、通知を作ります。
- リレーは、envelope もトークンも、ログに出しません。失敗のときに書くのは `push-upstream-failed`（OS と HTTP の状態コードだけ）です。

## 環境変数

| 変数                                                               | 内容                                                                                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_PRIVATE_KEY` / `APNS_TOPIC` | APNs。4 つそろったときだけ有効。`APNS_PRIVATE_KEY` は `.p8` の PEM（`\n` で 1 行にしてよい）。`APNS_TOPIC` はアプリのバンドル ID |
| `FCM_PROJECT_ID` / `FCM_CLIENT_EMAIL` / `FCM_PRIVATE_KEY`          | FCM。サービスアカウントの JSON の `project_id`、`client_email`、`private_key`。3 つそろったときだけ有効                          |

一部だけの設定は、起動時のエラーにします。

## 確かめていないこと

- 実際の APNs / FCM には、つないでいません（テストは、同じプロセスに立てた、偽の APNs / FCM のサーバーで行います）。
- 開発版のアプリ（`jp.kinocode.k3code.dev` など）は、バンドル ID が違うので、`APNS_TOPIC` が本番のバンドル ID のリレーでは届きません。
