# K3 Relay を第三者が検証する手順

公開リレー（`https://relay.k3.kinocode.jp`）が、このリポジトリの公開コードから作られたものだと、自分の手で確かめるための手順です。何が確かめられて、何が確かめられないかは、最後の「限界」に率直に書いてあります。先にそこを読んでも構いません。

確かめられるのは、次の 4 つの対応です。

1. 動いているリレーが名乗るコミットとイメージのダイジェスト
2. そのコミットのソースコード（このリポジトリ）
3. そのソースを同じ Dockerfile でビルドしたときのダイジェスト
4. GitHub が署名した「このダイジェストは、この workflow が、このコミットから作った」という記録（provenance）

## 準備

- `git`、`curl`、`jq`
- `docker`（Buildx 0.13 以上。`rewrite-timestamp` に必要です）
- `gh`（GitHub CLI。`gh attestation verify` が使えるもの）
- 手順 3 では、リレーのイメージと同じ 2 つの CPU（amd64 と arm64）をビルドします。片方が自分の CPU と違えば、エミュレーションを入れます: `docker run --privileged --rm tonistiigi/binfmt --install all`

以下、変数を使います。

```sh
RELAY=https://relay.k3.kinocode.jp
REPO=kinocode-jp/k3code
IMAGE=ghcr.io/kinocode-jp/k3-relay
```

## 1. リレーが名乗る値を取る

```sh
curl -fsS "$RELAY/.well-known/k3-relay" | tee relay.json | jq .
COMMIT=$(jq -r .gitCommit relay.json)
DIGEST=$(jq -r .imageDigest relay.json)
```

`gitCommit`（40 桁の 16 進）、`imageDigest`（`sha256:…`）、`schemaHash`、上限値が返ります。`unknown` が返ったら、ビルド引数やデプロイの引数が渡されていないので、検証できません。

## 2. そのコミットを取り出す

```sh
git clone https://github.com/$REPO.git k3code
cd k3code
git checkout "$COMMIT"
git branch -r --contains "$COMMIT"   # origin/main が出れば、main の履歴にあるコミット
```

`git checkout` が失敗する、またはどのブランチにもないコミットなら、それは公開されていないコードです。

## 3. 同じ Dockerfile で再ビルドして、ダイジェストを照合する

```sh
cd infra/k3-relay
docker buildx create --use --name k3-verify   # 初回だけ。docker-container ドライバーが要ります
docker buildx build . \
  --no-cache \
  --platform linux/amd64,linux/arm64 \
  --build-arg "GIT_COMMIT=$COMMIT" \
  --build-arg "SOURCE_DATE_EPOCH=$(git log -1 --format=%ct "$COMMIT")" \
  --provenance=false --sbom=false \
  --output type=oci,dest=/tmp/k3-relay.tar,rewrite-timestamp=true
tar -xOf /tmp/k3-relay.tar index.json | jq -r '.manifests[0].digest'
```

出た値が、手順 1 の `imageDigest` と同じなら、「公開コードをこの条件でビルドすると、公開リレーと同じイメージになる」ことが確かめられました。

CI も、プッシュのたびに同じ再ビルドをして、結果を実行の要約に出します（`K3 Relay build` の `reproduce` ジョブ）。

### 同じダイジェストになるための条件

ビルドの結果が、ソースだけで決まるように、次を固定しています。1 つでも欠けると、ダイジェストはずれます。

| 条件           | 内容                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ベースイメージ | `Dockerfile` が `node:24-alpine` をダイジェストで固定しています（タグは動くので使いません）                                                                             |
| 時計           | `SOURCE_DATE_EPOCH` をコミットの時刻にし、`rewrite-timestamp=true` で、すべてのファイルの時刻をそれに揃えます                                                           |
| ビルドの記録   | `--provenance=false --sbom=false`。BuildKit 自身の記録には時刻とビルダーの情報が入り、ダイジェストが毎回変わってしまうためです。署名つきの出所は、手順 4 で別に付けます |
| ラベル         | イメージにラベルや注釈を付けません（作成時刻が入るため）                                                                                                                |
| コミット       | `GIT_COMMIT` をビルド引数で渡します。これは環境変数としてイメージに入るので、コミットが違えばダイジェストも違います                                                     |
| 依存           | 実行時の依存は `ws@8.22.0` だけで、`npm install` の時点の npm レジストリから取ります。`ws` は、さらなる依存を持ちません                                                 |

### 一致しないとき

- まず、`git status` が空で、`$COMMIT` のままか確かめてください。ファイルを書き換えていないことが前提です。
- `umask` が `022` でない環境で checkout すると、ファイルの権限が変わり、ダイジェストがずれることがあります（既知の課題。下の「限界」）。`umask 022` で、取り直してください。
- BuildKit の版が大きく違うと、レイヤーの作り方が変わることがあります。
- それでも一致しないときは、`index.json` から出る、アーキテクチャごとのマニフェストのダイジェストを、公開イメージの `docker buildx imagetools inspect "$IMAGE@$DIGEST"` と見比べて、どちらの CPU でずれているかを、Issue に書いてください。**一致しないことは、不正の証拠ではありませんが、検証が成立していないということです。** そのまま「検証できた」とは言わないでください。

## 4. 出所の証明（provenance）を確認する

```sh
gh attestation verify "oci://$IMAGE@$DIGEST" \
  --repo "$REPO" \
  --signer-workflow "$REPO/.github/workflows/k3-relay-build.yml" \
  --format json | tee attestation.json | jq '.[0].verificationResult.signature.certificate | {sourceRepositoryURI, sourceRepositoryDigest, sourceRepositoryRef, githubWorkflowRepository}'
```

成功すると、「このダイジェストは、`$REPO` の `k3-relay-build.yml` が、GitHub Actions で作った」ことが、GitHub の署名（Sigstore）で確かめられます。表示された `sourceRepositoryDigest` が、手順 1 の `gitCommit` と同じであることを確かめてください。

署名が示すのは、「どの workflow が、どのコミットから、そのダイジェストを作ったか」です。コードが安全だとは言っていません。

## 5. 保存データの一覧と、実際のスキーマを照合する

保存するデータの全部は [DATA.md](./DATA.md) にあります。これは `src/store.ts` のスキーマから自動で作られ、ずれると CI が失敗します。

```sh
# (1) 手元のソースから、一覧を作り直して、コミット済みの DATA.md と比べる（Node 22.18 以上）
cd "$(git rev-parse --show-toplevel)"
node infra/k3-relay/scripts/generate-data-inventory.ts --check

# (2) 公開イメージの中のソースが、このコミットのソースと同じか
docker create --name k3-image "$IMAGE@$DIGEST" >/dev/null
docker cp k3-image:/app/src ./image-src
docker rm k3-image >/dev/null
diff -r ./image-src infra/k3-relay/src && echo "イメージのソースは、このコミットと同じです"

# (3) リレーが返す schemaHash が、DATA.md の先頭の値と同じか
jq -r .schemaHash relay.json
grep -E '^`[0-9a-f]{64}`$' infra/k3-relay/docs/DATA.md
```

(3) の 2 つの値が同じなら、動いているリレーは、`DATA.md` に書かれたスキーマと同じスキーマだと名乗っています。

「保存しないもの」（IP アドレス、通信内容、端末名など）は、スキーマに該当する列が無いこと、ソースにそれを書く処理が無いこと、`src/privacy.test.ts` が、DB のファイルのバイト列、全テーブル、ログに、IP、端末名、通信内容、招待コードが現れないことを検査していること、で裏づけられています。

## 6. 自分でリレーを動かす

検証より確実な方法は、信用しなくてよい自分のリレーを使うことです。K3 の設定で、リレーの URL を差し替えられます。

- 手順は [README の「セルフホストの手順」](../README.md) にあります（Caddy と `docker compose`）。
- 自分でビルドせず、CI が作ったイメージをそのまま動かすこともできます。

  ```sh
  cd infra/k3-relay
  IMAGE_DIGEST="$DIGEST" RELAY_DOMAIN=relay.example.com \
    docker compose -f docker-compose.example.yml -f scripts/docker-compose.deploy.yml up -d --no-build
  ```

- 動き出したリレーが、名乗る値の通りか確かめる道具: `sh infra/k3-relay/scripts/verify-live.sh https://relay.example.com "$DIGEST" "$COMMIT"`
- 非公開にしたいときは、`REQUIRE_INVITE=1` にします。

## 限界

率直に書きます。

1. **稼働中のサーバーが、公開コードと同じだと、外から証明する方法はありません。** `/.well-known/k3-relay` は、サーバー自身の申告です。公開コードと違うものを動かしている（またはコードを書き換えた）サーバーでも、同じダイジェストとコミットを返せます。手順 1〜5 で確かめられるのは、「公開されているイメージは、公開コードから作られた」ことと、「運営が、そのイメージを動かすと言っている」ことまでです。リモートアテステーション（TEE）のような、実行中の中身を外から証明する仕組みは使っていません。
2. **だから、透明性は主な保証ではありません。** 主な保証は、リレーが嘘をついても、暗号文しか見えない設計（ホストと端末の間の E2E。仕様 §6、§7）です。リレーの透明性は、その外側の、二重の備えです。
3. provenance は、ダイジェストの出所を示すもので、コードに脆弱性や悪意が無いことは示しません。コードは公開されているので、読んで確かめられます。
4. ビルドは、運営の管理する CI のランナーで動きます。手順 3 の再ビルドが一致すれば、ランナーを信用しなくても済みますが、一致しない場合に、どちらが正しいかは、この手順だけでは決められません。
5. 再現可能なビルドは、完全ではありません。`umask` で変わるファイルの権限、固定していない Dockerfile の構文のバージョン（`# syntax=docker/dockerfile:1`）、`npm install` の時点のレジストリが、ずれの原因になりえます。CI の `reproduce` ジョブが、毎回の一致を見張っています。
6. Caddy（TLS を終端する別のイメージ）は、この検証の対象外です。公開されている `Caddyfile` と `docker-compose.example.yml` が、運営の設定のはずですが、同じ理由で、外から証明はできません。接続のメタデータについては [TRANSPARENCY.md](./TRANSPARENCY.md) を読んでください。
7. 運営は、サーバーの OS と OCI の管理画面から、DB のファイルと、通信の流れ（いつ、どこから、どのくらい）を見られる立場にいます。見えるものの範囲は、TRANSPARENCY.md に書きました。
