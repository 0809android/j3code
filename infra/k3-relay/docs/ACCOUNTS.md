# K3 Relay のアカウント（GitHub / Google / Apple でのサインイン）

仕様 `spec-v3.5.md` の §20 の実装についての、運営者向けの手順書です。アカウントは**任意の入口**で、QR のペアリングは、これまでどおりアカウントなしで使えます。

## 何をするもので、何をしないか

- ホストと端末で同じアカウントにサインインすると、端末に、そのアカウントのホストの一覧（hostId と `Hk`）が出ます。
- **アカウントは、権限を与えません。** 端末がホストに入るには、ホストの利用者の承認（確認コードの見比べ。既定でオン）が要ります。リレーが乗っ取られても、承認の画面より先には進めません（§20.3）。
- 承認をオフにできるのは、ホストの利用者が危険を示されたうえで選んだときだけです（選んだ時刻を記録します）。

## 仕組み（要点）

1. アプリ（またはホスト）が、PKCE の `code_challenge`、戻り先、自分の鍵（端末は `Dk`、ホストは `Hk`）を付けて、`POST /v1/account/oauth/<provider>/start` を呼ぶ。
2. リレーが、自分の PKCE、`state`、（OIDC は）`nonce` を作り、提供元の認可 URL を返す。**提供元の戻り先は、リレーの https**（`<RELAY_PUBLIC_URL>/v1/account/oauth/<provider>/callback`）。
3. 提供元から戻ったら、リレーが、`client_secret` を使ってコードを交換し、本人の識別子を確かめる。
   - GitHub: 数値の `id`。トークンを `POST /applications/{client_id}/token` で K3 のアプリに出たものか確かめ、すぐに `DELETE` で失効させる。ログイン名は使わない（変えられ、再利用される）。
   - Google / Apple: ID トークンの署名（提供元の JWKS。1 時間キャッシュ、未知の `kid` は最短 1 分ごとに再取得）、`iss`、`aud`（リストのときは `azp` も）、`exp`、`iat`、`nonce`。`alg` は RS256 / ES256 だけ（`none` と HMAC は拒否）。
4. リレーは、アプリの戻り先に、一回限りの K3 のコード（有効 1 分）を返す。このコードは、アプリの PKCE の verifier と、手順 1 の鍵の署名がないと使えない（`k3relay://` を横取りされても無駄）。
5. アプリが `POST /v1/account/token` でコードを交換し、1 時間のアカウントのトークン（リレーの Ed25519 のアカウント鍵で署名。K3 のどの鍵とも別）を得る。以後の呼び出しは、すべて、そのトークンと、結びついた鍵の署名（パス、時刻、一回限りの nonce、引数）つき。
6. 端末は、ホストごとの新しい鍵について、5 分のチケット（`aud` = hostId、`cnf` = その鍵の deviceId）を受け取り、`/v1/client/<hostId>?account=1` でノックする。ホストは、E2E の中で、チケットを自分がサインインしたときに知ったアカウント鍵で検証し、`Dk` の所有の証明を確かめ、承認の画面に出す。

戻り先として許すのは、`k3relay://account/callback`、ループバック（`http://127.0.0.1:<任意のポート>/k3relay/account/callback`、`[::1]`、`localhost`）、`ACCOUNT_WEB_REDIRECTS` に列挙した完全一致の URL だけです。**ホストは、ループバックだけ**（他人が始めたサインインのリンクで、他人のホストを自分のアカウントに入れられないように）。

## 環境変数

提供元は、すべての変数がそろったものだけが有効になります。どの提供元も設定されていなければ、アカウントの API は、すべて `404` を返します。半端な設定や、鍵の欠けた設定では、起動しません。

| 変数                                                                       | 内容                                                                                                                         |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_PUBLIC_URL`                                                         | リレー自身の https の URL（例: `https://relay.k3.kinocode.jp`）。提供元に登録する戻り先は、ここから作る                      |
| `ACCOUNT_TOKEN_SEED`                                                       | アカウントのトークンの Ed25519 の鍵（32 バイトの乱数、base64url）。`openssl rand 32 \| basenc --base64url \| tr -d =` など   |
| `ACCOUNT_ID_HMAC_KEY`                                                      | 提供元の識別子の HMAC の鍵（32 文字以上の乱数）。**DB とバックアップの外に置く**。入れ替えると、全員が新しいアカウントになる |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`                                | GitHub の OAuth アプリ                                                                                                       |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                                | Google の OAuth クライアント（ウェブ アプリケーション）                                                                      |
| `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | Sign in with Apple（Services ID、チーム ID、鍵 ID、`.p8` の PEM。改行は `\n` でもよい）                                      |
| `ACCOUNT_WEB_REDIRECTS`                                                    | ブラウザ版のクライアントの戻り先（コンマ区切り、完全一致、https）                                                            |
| `MAX_HOSTS_PER_ACCOUNT`                                                    | 1 アカウントのホストの上限（既定 20）                                                                                        |
| `ACCOUNT_STARTS_PER_MINUTE_PER_IP`                                         | サインインの開始の上限（既定 10。IPv6 は /64）                                                                               |
| `ACCOUNTS_PER_IP_PER_DAY`                                                  | 新しいアカウントの作成の上限（既定 20）                                                                                      |
| `ACCOUNT_ADMISSIONS_PER_HOST_PER_HOUR`                                     | `?account=1` のノックの、ホストごとの上限（既定 20。同時は 2）                                                               |

`ACCOUNT_TOKEN_SEED` を入れ替えると、ホストが覚えたアカウント鍵と合わなくなり、ホストは、サインインし直すまで、アカウント経由の端末を拒否します（安全側）。

## OAuth アプリの登録の手順（運営者が、自分の名前で行う）

**このリポジトリは、登録をしていません（秘密を持ちません）。** 次の手順で、運営者（Kinocode）の名前で登録し、得た値をリレーの環境（`/etc/k3-relay/relay.env` など。リポジトリには入れない）に置いてください。

### GitHub

1. Kinocode の組織の Settings → Developer settings → OAuth Apps → New OAuth App。
2. Homepage URL: プライバシーポリシーを置くリレーのドメイン。Authorization callback URL: `https://relay.k3.kinocode.jp/v1/account/oauth/github/callback`（`RELAY_PUBLIC_URL` と完全に一致させる）。
3. スコープは要求しません（公開の情報から数値の `id` だけを読みます）。
4. Client ID と、Generate a new client secret の値を、`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` に。
5. CLI / ヘッドレス用のデバイスフローは、まだ実装していません（下の「仕様との差」）。

### Google

1. Google Cloud のコンソールで、K3 用のプロジェクトを作り、OAuth 同意画面（外部）を設定する。アプリ名、サポートのメール、**プライバシーポリシーの URL**、承認済みドメイン（`kinocode.jp`）。ドメインの所有確認（Search Console）が要る。
2. スコープは `openid` だけ（メールとプロフィールは要求しない）。
3. 認証情報 → OAuth クライアント ID → 種類「ウェブ アプリケーション」。承認済みのリダイレクト URI: `https://relay.k3.kinocode.jp/v1/account/oauth/google/callback`。
4. クライアント ID とシークレットを、`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` に。
5. 未確認アプリの画面が出る間は、新規の利用者は合計 100 人まで（https://support.google.com/cloud/answer/7454865）。基本のスコープだけなら審査は軽い想定ですが、公開の前に、同意画面の公開ステータスを「本番」にして確かめてください。

### Apple（iOS のアプリでアカウントを出すときは必須。App Store の規則 4.8）

1. Apple Developer の Certificates, Identifiers & Profiles で、App ID に Sign in with Apple を有効にする。
2. Services ID を作り（これが `APPLE_CLIENT_ID`）、Sign in with Apple を設定する。Domains: `relay.k3.kinocode.jp`、Return URLs: `https://relay.k3.kinocode.jp/v1/account/oauth/apple/callback`。
3. Keys で Sign in with Apple の鍵を作り、`.p8` を一度だけダウンロードする。鍵 ID を `APPLE_KEY_ID`、チーム ID を `APPLE_TEAM_ID`、`.p8` の中身を `APPLE_PRIVATE_KEY` に。
4. スコープは要求しません（`name` と `email` を求めないので、戻りは通常のクエリで届きます）。リレーは、交換のたびに、5 分の ES256 の `client_secret` を作ります。

## 公開の前に確かめること

- [ ] プライバシーポリシーを、リレーのドメインで公開した。**アカウントを削除しても、バックアップに最大 30 日残る**ことを書いた（§20.5）。
- [ ] 3 つの提供元の戻り先が、`RELAY_PUBLIC_URL` と完全に一致している（末尾の `/` も）。
- [ ] `ACCOUNT_TOKEN_SEED` と `ACCOUNT_ID_HMAC_KEY` が、DB のバックアップと別の場所にあり、バックアップの対象に入っていない。
- [ ] `/.well-known/k3-relay` の `accounts.providers` に、有効にした提供元だけが出る。`accounts.key` は、ホストが覚える鍵なので、むやみに入れ替えない。
- [ ] iOS のアプリで、GitHub / Google と同時に、Sign in with Apple を出している。
- [ ] 利用者に、各提供元の 2 段階認証を勧める文言がある（§20.3）。
- [ ] Google の同意画面を「本番」にして、未確認アプリの画面が出ないことを確かめた。

## 保存するもの

`accounts`（ランダムなアカウント ID、作成日）、`identities`（提供元、識別子の HMAC、アカウント ID）、`account_hosts`（アカウント ID、hostId）。列ごとの説明は [DATA.md](./DATA.md)。メールアドレス、氏名、アバター、ログイン名は、保存もログへの出力もしません（`src/privacy.test.ts` が、DB のファイルのバイト列とログで確かめています）。サインインの途中の状態、一回限りのコード、アカウントのトークンは、メモリだけです。

## 乱用への備え（§14）

- サインインは、本物の提供元のアカウントが要るので、PoW は課しません。代わりに、開始の回数（IP ごと 1 分 10 回）、新しいアカウントの数（IP ごと 1 日 20）、途中の状態の総数（2000）に上限があります。
- ホストをアカウントに載せられるのは、**登録済みのホスト**だけです。登録には、これまでどおり PoW が要ります。アカウントあたりのホストは 20 まで。
- `?account=1` は、ホストごとに 1 時間 20 回、同時 2 本。チケットのない接続は、署名の確認の後で `4401` です。

## 仕様との差

- CLI / ヘッドレスのホストのデバイスコード（GitHub のデバイスフロー、Google の Limited Input）は、まだありません。ホストは、ホストのマシンのブラウザでサインインします（ループバック）。§20.2 の「デバイスコードのセッションはホストの登録だけ」「新しいホストを承認済みの端末に知らせる」は、デバイスコードを作るときに足します。
- 複数の提供元のひも付け（§20.2）は、まだありません。提供元ごとに、別のアカウントになります。
- ホストのサインアウトは、手元の記録を消し（以後、アカウント経由の端末を拒否）、1 時間のセッションが残っていれば、リレーの一覧からも外します。残っていなければ、リレーの一覧には残ります（端末から外せます。入ることはできません）。
- Google の `iss` パラメーター（RFC 9207）は、届いたときだけ確かめます（GitHub は送りません）。
