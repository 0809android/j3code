import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { ACCOUNT_LABELS, AccountTokens, isAllowedAppRedirect } from "./account.ts";
import {
  PUBLIC_URL,
  TEST_SEED,
  accountCall,
  accountConfig,
  accountRequestBody,
  hostTicket,
  redeemCode,
  relayCallback,
  signIn,
  startAppFlow,
  startFakeProvider,
  visitProvider,
  type AccountSession,
  type FakeProvider,
} from "./account.testkit.ts";
import { base64url, decodeBase64url } from "./bytes.ts";
import type { AccountProviderKind, RelayConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { LABELS, deviceIdOf, signingInput } from "./crypto.ts";
import {
  connectControl,
  newEd25519,
  newHost,
  newP256,
  open,
  registerHost,
  tryOpen,
  withRelay,
  type Signer,
  type TestHost,
  type TestRelay,
} from "./relay.testkit.ts";

async function withAccounts<T>(
  work: (relay: TestRelay, fake: FakeProvider) => Promise<T>,
  options: { kinds?: ReadonlyArray<AccountProviderKind>; extra?: Partial<RelayConfig> } = {},
): Promise<T> {
  const fake = await startFakeProvider();
  try {
    return await withRelay(accountConfig(fake, options.kinds, options.extra), (relay) => {
      fake.nowMs = () => relay.clock.now;
      return work(relay, fake);
    });
  } finally {
    await fake.close();
  }
}

/** A host that is registered with the relay and on the account of `session`'s person. */
async function hostOnAccount(relay: TestRelay, provider: AccountProviderKind = "github") {
  const host = newHost();
  await registerHost(relay, host);
  const hostSession = await signIn(relay, provider, host.signer, {
    use: "host",
    redirect: "http://127.0.0.1:3773/k3relay/account/callback",
  });
  const added = await accountCall(relay, hostSession, "/v1/account/hosts/add");
  expect(added.status).toBe(200);
  return { host, hostSession };
}

async function listHosts(relay: TestRelay, session: AccountSession) {
  const response = await accountCall(relay, session, "/v1/account/hosts");
  return response;
}

describe("accounts are off unless configured", () => {
  it("answers 404 on every account route, and the account knock, without a provider", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      for (const [method, path] of [
        ["GET", "/v1/account/providers"],
        ["POST", "/v1/account/oauth/github/start"],
        ["GET", "/v1/account/oauth/github/callback?code=x&state=y"],
        ["POST", "/v1/account/token"],
        ["POST", "/v1/account/hosts"],
        ["POST", "/v1/account/hosts/token"],
        ["POST", "/v1/account/delete"],
      ] as const) {
        const response = await relay.http(method, path, method === "POST" ? {} : undefined);
        expect(response.status, `${method} ${path}`).toBe(404);
      }
      expect(await tryOpen(relay.wsUrl(`/v1/client/${host.hostId}?account=1`))).toEqual({
        status: 404,
      });
      const known = await relay.http("GET", "/.well-known/k3-relay");
      expect(known.json).not.toHaveProperty("accounts");
    }));

  it("turns on only the providers that are configured", () =>
    withAccounts(
      async (relay) => {
        expect((await relay.http("GET", "/v1/account/providers")).json).toEqual({
          providers: ["google"],
        });
        const github = await relay.http("POST", "/v1/account/oauth/github/start", {});
        expect(github.status).toBe(404);
        const apple = await relay.http("GET", "/v1/account/oauth/apple/callback?state=x");
        expect(apple.status).toBe(404);
      },
      { kinds: ["google"] },
    ));

  it("refuses to start with half a provider, or without the keys accounts need", () => {
    expect(() => loadConfig({ GITHUB_CLIENT_ID: "id" })).toThrow(/GITHUB_CLIENT_SECRET/u);
    const github = { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" };
    expect(() => loadConfig(github)).toThrow(/RELAY_PUBLIC_URL/u);
    expect(() => loadConfig({ ...github, RELAY_PUBLIC_URL: "https://r.example" })).toThrow(
      /ACCOUNT_TOKEN_SEED/u,
    );
    expect(() =>
      loadConfig({
        ...github,
        RELAY_PUBLIC_URL: "https://r.example",
        ACCOUNT_TOKEN_SEED: TEST_SEED,
      }),
    ).toThrow(/ACCOUNT_ID_HMAC_KEY/u);
    expect(() =>
      loadConfig({
        ...github,
        RELAY_PUBLIC_URL: "http://r.example",
        ACCOUNT_TOKEN_SEED: TEST_SEED,
        ACCOUNT_ID_HMAC_KEY: "k".repeat(40),
      }),
    ).toThrow(/https/u);
    const config = loadConfig({
      ...github,
      RELAY_PUBLIC_URL: "https://r.example/",
      ACCOUNT_TOKEN_SEED: TEST_SEED,
      ACCOUNT_ID_HMAC_KEY: "k".repeat(40),
    });
    expect(config.accountProviders.map((p) => p.kind)).toEqual(["github"]);
    expect(config.publicUrl).toBe("https://r.example");
    expect(loadConfig({}).accountProviders).toEqual([]);
  });
});

describe("OAuth through the relay", () => {
  it("signs a device in with GitHub and keeps the provider's secret to itself", () =>
    withAccounts(async (relay, fake) => {
      const device = newEd25519();
      const flow = await startAppFlow(relay, "github", device);
      const authorize = new URL(flow.authorizeUrl);
      expect(authorize.searchParams.get("redirect_uri")).toBe(
        `${PUBLIC_URL}/v1/account/oauth/github/callback`,
      );
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorize.searchParams.has("scope")).toBe(false);
      expect(flow.authorizeUrl).not.toContain("secret");
      const visit = await visitProvider(flow.authorizeUrl);
      const back = await relayCallback(relay, visit.relayCallback);
      expect(back.kind).toBe("app");
      if (back.kind !== "app") return;
      expect(`${back.url.protocol}//${back.url.host}${back.url.pathname}`).toBe(
        "k3relay://account/callback",
      );
      expect(back.url.searchParams.get("state")).toBe(flow.appState);
      // The provider's own code never reaches the app; the app gets a K3 code.
      expect(back.url.searchParams.get("code")).not.toBe(visit.query.get("code"));
      const redeemed = await redeemCode(relay, flow, back.url.searchParams.get("code") ?? "");
      expect(redeemed.status).toBe(200);
      expect(redeemed.json).toMatchObject({ use: "device" });
      expect(redeemed.text).not.toContain("gh-secret");
      // The relay checked the token was for this app, then revoked it.
      expect(fake.revokedTokens).toHaveLength(1);
      expect(fake.tokenRequests[0]?.get("client_secret")).toBe("gh-secret-DO-NOT-LOG");
    }));

  it("refuses a callback whose state it did not issue, or issued for another provider", () =>
    withAccounts(async (relay) => {
      const flow = await startAppFlow(relay, "google", newEd25519());
      const visit = await visitProvider(flow.authorizeUrl);
      const forged = visit.relayCallback.replace(/state=[^&]+/u, "state=forged-state-value-000000");
      expect((await relayCallback(relay, forged)).kind).toBe("failed");
      const crossed = visit.relayCallback.replace("/oauth/google/", "/oauth/github/");
      expect(await relayCallback(relay, crossed)).toMatchObject({ kind: "failed", status: 400 });
      // A state is single use: the crossed attempt spent it.
      expect((await relayCallback(relay, visit.relayCallback)).kind).toBe("failed");
    }));

  it("refuses a callback that names another issuer (RFC 9207)", () =>
    withAccounts(async (relay, fake) => {
      fake.redirectIss = "https://evil.example";
      const flow = await startAppFlow(relay, "google", newEd25519());
      const visit = await visitProvider(flow.authorizeUrl);
      expect((await relayCallback(relay, visit.relayCallback)).kind).toBe("failed");
      fake.redirectIss = `${fake.origin}/google`;
      const second = await startAppFlow(relay, "google", newEd25519());
      const ok = await relayCallback(
        relay,
        (await visitProvider(second.authorizeUrl)).relayCallback,
      );
      expect(ok.kind).toBe("app");
    }));

  it("uses its K3 code once, only with the app's PKCE verifier, redirect and key", () =>
    withAccounts(async (relay) => {
      const device = newEd25519();
      const pass = async () => {
        const flow = await startAppFlow(relay, "github", device);
        const back = await relayCallback(
          relay,
          (await visitProvider(flow.authorizeUrl)).relayCallback,
        );
        if (back.kind !== "app") throw new Error("no code");
        return { flow, code: back.url.searchParams.get("code") ?? "" };
      };
      const wrongVerifier = await pass();
      const bad = await redeemCode(relay, wrongVerifier.flow, wrongVerifier.code, {
        verifier: base64url(NodeCrypto.randomBytes(32)),
      });
      expect(bad).toMatchObject({ status: 400, json: { error: "invalid-grant" } });
      // The code was spent by the wrong attempt, even with the right verifier afterwards.
      expect((await redeemCode(relay, wrongVerifier.flow, wrongVerifier.code)).status).toBe(400);

      const wrongRedirect = await pass();
      expect(
        (
          await redeemCode(relay, wrongRedirect.flow, wrongRedirect.code, {
            redirect: "http://127.0.0.1:9/k3relay/account/callback",
          })
        ).status,
      ).toBe(400);

      // Someone who caught the code from `k3relay://` has neither the verifier nor the key.
      const stolen = await pass();
      const thief = newEd25519();
      const ts = relay.clock.now;
      const thiefSig = base64url(
        thief.sign(Buffer.concat([Buffer.from(stolen.code), Buffer.from(String(ts))])),
      );
      expect((await redeemCode(relay, stolen.flow, stolen.code, { sig: thiefSig })).status).toBe(
        400,
      );

      const good = await pass();
      expect((await redeemCode(relay, good.flow, good.code)).status).toBe(200);
      expect((await redeemCode(relay, good.flow, good.code)).status).toBe(400);
    }));

  it("lets the provider refuse a reused provider code, and a PKCE verifier that does not match", () =>
    withAccounts(async (relay, fake) => {
      const flow = await startAppFlow(relay, "github", newEd25519());
      const visit = await visitProvider(flow.authorizeUrl);
      expect((await relayCallback(relay, visit.relayCallback)).kind).toBe("app");
      // Replaying the provider's redirect: the relay's state is spent, so nothing is exchanged.
      const requests = fake.tokenRequests.length;
      expect((await relayCallback(relay, visit.relayCallback)).kind).toBe("failed");
      expect(fake.tokenRequests.length).toBe(requests);
      // The relay sends its own verifier; the fake checks it against the challenge.
      const sent = fake.tokenRequests.at(-1)?.get("code_verifier") ?? "";
      expect(sent).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(sent).not.toBe(flow.verifier);
    }));

  it("only sends codes back to the app's scheme, loopback, or listed web addresses", () => {
    const web = ["https://app.k3.example/k3relay/account/callback"];
    expect(isAllowedAppRedirect("k3relay://account/callback", "device", web)).toBe(true);
    expect(
      isAllowedAppRedirect("http://127.0.0.1:51234/k3relay/account/callback", "device", web),
    ).toBe(true);
    expect(isAllowedAppRedirect("http://[::1]:80/k3relay/account/callback", "host", web)).toBe(
      true,
    );
    expect(isAllowedAppRedirect(web[0]!, "device", web)).toBe(true);
    // A host's code must come back to the host's own machine.
    expect(isAllowedAppRedirect("k3relay://account/callback", "host", web)).toBe(false);
    expect(isAllowedAppRedirect(web[0]!, "host", web)).toBe(false);
    for (const bad of [
      "https://app.k3.example/k3relay/account/callback?x=1",
      "https://app.k3.example/k3relay/account/callback/",
      "https://evil.example/k3relay/account/callback",
      "http://127.0.0.1.evil.example:80/k3relay/account/callback",
      "http://127.0.0.1:80/other",
      "http://192.168.1.2:80/k3relay/account/callback",
      "k3relay://account/callback#x",
      "k3relayx://account/callback",
    ]) {
      expect(isAllowedAppRedirect(bad, "device", web), bad).toBe(false);
    }
  });

  it("refuses to start a flow toward a return address it does not allow", () =>
    withAccounts(async (relay) => {
      await expect(
        startAppFlow(relay, "github", newEd25519(), { redirect: "https://evil.example/cb" }),
      ).rejects.toThrow(/redirect-not-allowed/u);
      await expect(
        startAppFlow(relay, "github", newHost().signer, { use: "host" }),
      ).rejects.toThrow(/redirect-not-allowed/u);
    }));

  it("never redirects to an unregistered provider callback (the provider stops it)", async () => {
    const fake = await startFakeProvider();
    try {
      await withRelay(
        { ...accountConfig(fake, ["github"]), publicUrl: "https://relay.elsewhere" },
        async (relay) => {
          const flow = await startAppFlow(relay, "github", newEd25519());
          await expect(visitProvider(flow.authorizeUrl)).rejects.toThrow(/400/u);
        },
      );
    } finally {
      await fake.close();
    }
  });

  it("refuses a GitHub token that was issued to another app", () =>
    withAccounts(async (relay, fake) => {
      fake.githubAppClientId = "someone-elses-app";
      const flow = await startAppFlow(relay, "github", newEd25519());
      const back = await relayCallback(
        relay,
        (await visitProvider(flow.authorizeUrl)).relayCallback,
      );
      expect(back.kind).toBe("failed");
      // It is revoked all the same.
      expect(fake.revokedTokens).toHaveLength(1);
      expect(relay.logs.join("\n")).toContain("account-provider-failed");
    }));

  it("limits sign-in attempts per address", () =>
    withAccounts(
      async (relay) => {
        await startAppFlow(relay, "github", newEd25519());
        await startAppFlow(relay, "github", newEd25519());
        await expect(startAppFlow(relay, "github", newEd25519())).rejects.toThrow(/429/u);
      },
      { extra: { accountStartsPerMinutePerIp: 2 } },
    ));
});

describe("Google and Apple ID tokens", () => {
  const forged = async (
    kind: "google" | "apple",
    forge: (claims: Record<string, unknown>, header: Record<string, unknown>) => void,
    stranger = false,
  ) =>
    withAccounts(async (relay, fake) => {
      fake.forgeIdToken = forge;
      fake.signWithStrangerKey = stranger;
      const flow = await startAppFlow(relay, kind, newEd25519());
      return (await relayCallback(relay, (await visitProvider(flow.authorizeUrl)).relayCallback))
        .kind;
    });

  const kinds = ["google", "apple"] as const;

  it.each(kinds)("%s: accepts a correct ID token", async (kind) => {
    expect(await forged(kind, () => {})).toBe("app");
  });

  it.each(kinds)("%s: refuses a signature from a key outside the key set", async (kind) => {
    expect(await forged(kind, () => {}, true)).toBe("failed");
  });

  it.each(kinds)("%s: refuses the wrong aud, iss, exp, iat, nonce or sub", async (kind) => {
    expect(await forged(kind, (c) => void (c.aud = "another-client"))).toBe("failed");
    expect(
      await forged(kind, (c) => {
        c.aud = ["another-client", `${kind}-client-id`];
        c.azp = "another-client";
      }),
    ).toBe("failed");
    expect(await forged(kind, (c) => void (c.iss = "https://evil.example"))).toBe("failed");
    expect(await forged(kind, (c) => void (c.exp = (c.iat as number) - 3600))).toBe("failed");
    expect(await forged(kind, (c) => void (c.iat = (c.iat as number) + 3600))).toBe("failed");
    expect(await forged(kind, (c) => void (c.nonce = "replayed-nonce-from-another-flow"))).toBe(
      "failed",
    );
    expect(await forged(kind, (c) => void delete c.nonce)).toBe("failed");
    expect(await forged(kind, (c) => void delete c.sub)).toBe("failed");
  });

  it.each(kinds)("%s: refuses alg none, HMAC and an unknown kid", async (kind) => {
    expect(await forged(kind, (_c, h) => void (h.alg = "none"))).toBe("failed");
    expect(await forged(kind, (_c, h) => void (h.alg = "HS256"))).toBe("failed");
    expect(await forged(kind, (_c, h) => void (h.kid = "unknown-kid"))).toBe("failed");
  });

  it("asks Apple with a fresh ES256 client secret, never a stored one", () =>
    withAccounts(
      async (relay, fake) => {
        const flow = await startAppFlow(relay, "apple", newEd25519());
        await relayCallback(relay, (await visitProvider(flow.authorizeUrl)).relayCallback);
        const secret = fake.tokenRequests.at(-1)?.get("client_secret") ?? "";
        const [header = "", payload = ""] = secret.split(".");
        expect(JSON.parse(decodeBase64url(header)!.toString())).toMatchObject({ alg: "ES256" });
        expect(JSON.parse(decodeBase64url(payload)!.toString())).toMatchObject({
          iss: "TEAM123456",
          sub: "apple-client-id",
          aud: "https://appleid.apple.com",
        });
      },
      { kinds: ["apple"] },
    ));
});

describe("who an account is", () => {
  it("treats the same e-mail with a different sub as a different person", () =>
    withAccounts(async (relay, fake) => {
      fake.user = { ...fake.user, id: "google-sub-111" };
      const first = await signIn(relay, "google", newEd25519());
      fake.user = { ...fake.user, id: "google-sub-222" };
      const second = await signIn(relay, "google", newEd25519());
      const { host } = await hostOnAccount(relay, "google");
      // The host is on the second person's account (the host signed in last as sub-222).
      expect((await listHosts(relay, first)).json).toEqual({ hosts: [] });
      expect((await listHosts(relay, second)).json).toEqual({
        hosts: [{ hostId: host.hostId, hk: base64url(host.signer.pub) }],
      });
    }));

  it("keeps a GitHub person by numeric id when their login and e-mail change", () =>
    withAccounts(async (relay, fake) => {
      const { host } = await hostOnAccount(relay, "github");
      fake.user = { ...fake.user, login: "renamed-octo", email: "new@example.com", name: "New" };
      const later = await signIn(relay, "github", newEd25519());
      expect((await listHosts(relay, later)).json).toMatchObject({
        hosts: [{ hostId: host.hostId }],
      });
      // Someone who takes over the old login name has another id, and another account.
      fake.user = { ...fake.user, id: "999001", login: "kino-octo" };
      const squatter = await signIn(relay, "github", newEd25519());
      expect((await listHosts(relay, squatter)).json).toEqual({ hosts: [] });
    }));

  it("keeps the same sub at another provider apart (no linking by identifier)", () =>
    withAccounts(async (relay, fake) => {
      fake.user = { ...fake.user, id: "4242" };
      await hostOnAccount(relay, "github");
      const google = await signIn(relay, "google", newEd25519());
      expect((await listHosts(relay, google)).json).toEqual({ hosts: [] });
    }));
});

describe("account calls", () => {
  it("needs the bound key's signature: a stolen token alone does nothing", () =>
    withAccounts(async (relay) => {
      const session = await signIn(relay, "github", newEd25519());
      const thief: AccountSession = { ...session, signer: newEd25519() };
      expect((await listHosts(relay, thief)).status).toBe(401);
      expect((await listHosts(relay, session)).status).toBe(200);
    }));

  it("refuses a replayed request, a stale time and a token from another key", () =>
    withAccounts(async (relay) => {
      const session = await signIn(relay, "github", newEd25519());
      const body = accountRequestBody(relay, session, "/v1/account/hosts");
      expect((await relay.http("POST", "/v1/account/hosts", body)).status).toBe(200);
      expect((await relay.http("POST", "/v1/account/hosts", body)).status).toBe(401);
      const stale = accountRequestBody(relay, session, "/v1/account/hosts", {}, [], {});
      relay.clock.now += 5 * 60_000;
      expect((await relay.http("POST", "/v1/account/hosts", stale)).status).toBe(401);
      relay.clock.now -= 5 * 60_000;
      // Signed for one path, sent to another.
      const moved = accountRequestBody(relay, session, "/v1/account/hosts");
      expect((await relay.http("POST", "/v1/account/delete", moved)).status).toBe(401);
    }));

  it("refuses a token the relay did not sign, and an expired one", () =>
    withAccounts(async (relay) => {
      const session = await signIn(relay, "github", newEd25519());
      const other = new AccountTokens(Buffer.alloc(32, 9));
      const payload = JSON.parse(
        decodeBase64url(session.token.split(".")[1])!.toString(),
      ) as Record<string, unknown>;
      const forged = other.sign(payload as never);
      expect((await listHosts(relay, { ...session, token: forged })).status).toBe(401);
      relay.clock.now += 61 * 60_000;
      expect((await listHosts(relay, session)).status).toBe(401);
    }));

  it("lets a host add itself, only once registered, and never list hosts", () =>
    withAccounts(async (relay) => {
      const host = newHost();
      const hostSession = await signIn(relay, "github", host.signer, {
        use: "host",
        redirect: "http://127.0.0.1:3773/k3relay/account/callback",
      });
      expect((await accountCall(relay, hostSession, "/v1/account/hosts/add")).status).toBe(409);
      await registerHost(relay, host);
      expect((await accountCall(relay, hostSession, "/v1/account/hosts/add")).json).toEqual({
        hostId: host.hostId,
      });
      expect((await listHosts(relay, hostSession)).status).toBe(403);
      expect((await hostTicket(relay, hostSession, host.hostId, newEd25519())).status).toBe(403);
      // A device session cannot add hosts.
      const device = await signIn(relay, "github", newEd25519());
      expect((await accountCall(relay, device, "/v1/account/hosts/add")).status).toBe(403);
    }));

  it("caps the hosts on one account", () =>
    withAccounts(
      async (relay) => {
        await hostOnAccount(relay);
        await hostOnAccount(relay);
        const host = newHost();
        await registerHost(relay, host);
        const session = await signIn(relay, "github", host.signer, {
          use: "host",
          redirect: "http://127.0.0.1:3773/k3relay/account/callback",
        });
        expect(await accountCall(relay, session, "/v1/account/hosts/add")).toMatchObject({
          status: 429,
          json: { error: "limit" },
        });
      },
      { extra: { maxHostsPerAccount: 2 } },
    ));

  it("never shows another person's hosts, nor hands out tickets for them", () =>
    withAccounts(async (relay, fake) => {
      fake.user = { ...fake.user, id: "100" };
      const { host: mine } = await hostOnAccount(relay);
      fake.user = { ...fake.user, id: "200" };
      const { host: theirs } = await hostOnAccount(relay);
      fake.user = { ...fake.user, id: "100" };
      const me = await signIn(relay, "github", newEd25519());
      expect((await listHosts(relay, me)).json).toEqual({
        hosts: [{ hostId: mine.hostId, hk: base64url(mine.signer.pub) }],
      });
      expect((await hostTicket(relay, me, theirs.hostId, newEd25519())).status).toBe(404);
      expect((await hostTicket(relay, me, mine.hostId, newEd25519())).status).toBe(200);
    }));

  it("binds a host ticket only to a device key that signed for it", () =>
    withAccounts(async (relay) => {
      const { host } = await hostOnAccount(relay);
      const session = await signIn(relay, "github", newEd25519());
      const deviceKey = newP256();
      const response = await accountCall(
        relay,
        session,
        "/v1/account/hosts/token",
        {
          hostId: host.hostId,
          dalg: deviceKey.alg,
          dk: base64url(deviceKey.pub),
          dsig: base64url(newP256().sign(Buffer.from("not this"))),
        },
        ["hostId", "dalg", "dk", "dsig"],
      );
      expect(response.status).toBe(401);
      const ok = await hostTicket(relay, session, host.hostId, deviceKey);
      expect(ok.status).toBe(200);
      const claims = JSON.parse(
        decodeBase64url(String(ok.json?.token).split(".")[1])!.toString(),
      ) as Record<string, unknown>;
      expect(claims).toMatchObject({
        typ: "host-access",
        aud: host.hostId,
        cnf: deviceIdOf(deviceKey.alg, deviceKey.pub),
      });
      expect(ok.json?.hk).toBe(base64url(host.signer.pub));
    }));

  it("deletes the account and everything on it, from a signed-in device", () =>
    withAccounts(async (relay) => {
      const { host } = await hostOnAccount(relay);
      const session = await signIn(relay, "github", newEd25519());
      expect((await accountCall(relay, session, "/v1/account/delete")).json).toEqual({ ok: true });
      expect((await listHosts(relay, session)).status).toBe(401);
      expect(relay.relay.store.accountHostIds("x".repeat(32))).toEqual([]);
      // The host itself stays registered; only the account's list is gone.
      expect(relay.relay.store.getHost(host.hostId)).toBeDefined();
      const again = await signIn(relay, "github", newEd25519());
      expect((await listHosts(relay, again)).json).toEqual({ hosts: [] });
    }));

  it("lets a device take a host off its list, and a host only itself", () =>
    withAccounts(async (relay) => {
      const { host, hostSession } = await hostOnAccount(relay);
      const { host: other } = await hostOnAccount(relay);
      expect(
        (
          await accountCall(relay, hostSession, "/v1/account/hosts/remove", {
            hostId: other.hostId,
          })
        ).status,
      ).toBe(403);
      const device = await signIn(relay, "github", newEd25519());
      expect(
        (await accountCall(relay, device, "/v1/account/hosts/remove", { hostId: host.hostId }))
          .json,
      ).toEqual({ ok: true });
      expect((await listHosts(relay, device)).json).toMatchObject({
        hosts: [{ hostId: other.hostId }],
      });
    }));
});

/** Knocks with `?account=1` and the ticket, as the client does. */
async function knock(
  relay: TestRelay,
  host: TestHost,
  deviceKey: Signer,
  token: string,
  options: { signWith?: Signer; hostIdInSig?: string } = {},
) {
  const peer = await open(relay.wsUrl(`/v1/client/${host.hostId}?account=1`));
  const challenge = await peer.json();
  const nonce = Buffer.from(String(challenge.nonce), "base64url");
  const deviceId = deviceIdOf(deviceKey.alg, deviceKey.pub);
  const sig = (options.signWith ?? deviceKey).sign(
    signingInput(ACCOUNT_LABELS.client, options.hostIdInSig ?? host.hostId, deviceId, nonce),
  );
  await peer.send(
    JSON.stringify({
      type: "auth",
      alg: deviceKey.alg,
      dk: base64url(deviceKey.pub),
      token,
      sig: base64url(sig),
    }),
  );
  return peer;
}

describe("the account knock", () => {
  it("opens an anonymous session to the host, which decides; no grant is involved", () =>
    withAccounts(async (relay) => {
      const { host } = await hostOnAccount(relay);
      const control = await connectControl(relay, host);
      const session = await signIn(relay, "github", newEd25519());
      const deviceKey = newEd25519();
      const ticket = await hostTicket(relay, session, host.hostId, deviceKey);
      const peer = await knock(relay, host, deviceKey, String(ticket.json?.token));
      const opened = await control.peer.json();
      expect(opened).toMatchObject({
        type: "session-open",
        kind: "account",
        deviceId: deviceIdOf(deviceKey.alg, deviceKey.pub),
      });
      const data = await open(
        relay.wsUrl(`/v1/host/data/${String(opened.sessionId)}?t=${String(opened.token)}`),
      );
      expect(await peer.json()).toEqual({ type: "accepted" });
      await peer.send(Buffer.from("e2e hello"));
      expect((await data.next()).data.toString()).toBe("e2e hello");
      // The ticket does not work as a grant on the normal entrance.
      const normal = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      await normal.json();
      await normal.send(
        JSON.stringify({
          type: "auth",
          alg: deviceKey.alg,
          dk: base64url(deviceKey.pub),
          grant: ticket.json?.token,
          sig: base64url(deviceKey.sign(signingInput(LABELS.client, host.hostId, "x", "y"))),
        }),
      );
      expect((await normal.closed).code).toBe(4401);
    }));

  it("refuses a ticket for another host, another key, a wrong signature, or a removed host", () =>
    withAccounts(async (relay) => {
      const { host } = await hostOnAccount(relay);
      const { host: second } = await hostOnAccount(relay);
      await connectControl(relay, host);
      await connectControl(relay, second);
      const session = await signIn(relay, "github", newEd25519());
      const deviceKey = newEd25519();
      const ticket = String((await hostTicket(relay, session, host.hostId, deviceKey)).json?.token);
      const refused = async (peer: Awaited<ReturnType<typeof knock>>) => (await peer.closed).code;
      expect(await refused(await knock(relay, second, deviceKey, ticket))).toBe(4401);
      expect(await refused(await knock(relay, host, newEd25519(), ticket))).toBe(4401);
      expect(
        await refused(await knock(relay, host, deviceKey, ticket, { signWith: newEd25519() })),
      ).toBe(4401);
      expect(
        await refused(await knock(relay, host, deviceKey, ticket, { hostIdInSig: second.hostId })),
      ).toBe(4401);
      expect(await refused(await knock(relay, host, deviceKey, session.token))).toBe(4401);
      relay.clock.now += 6 * 60_000;
      expect(await refused(await knock(relay, host, deviceKey, ticket))).toBe(4401);
      relay.clock.now -= 6 * 60_000;
      await accountCall(relay, session, "/v1/account/hosts/remove", { hostId: host.hostId });
      expect(await refused(await knock(relay, host, deviceKey, ticket))).toBe(4401);
    }));

  it("limits knocks per host", () =>
    withAccounts(
      async (relay) => {
        const { host } = await hostOnAccount(relay);
        for (let i = 0; i < 2; i += 1) {
          const peer = await open(relay.wsUrl(`/v1/client/${host.hostId}?account=1`));
          peer.close();
          await peer.closed;
        }
        expect(await tryOpen(relay.wsUrl(`/v1/client/${host.hostId}?account=1`))).toEqual({
          status: 429,
        });
      },
      { extra: { accountAdmissionsPerHostPerHour: 2 } },
    ));

  it("answers an unknown host like a missing one", () =>
    withAccounts(async (relay) => {
      expect(await tryOpen(relay.wsUrl(`/v1/client/${"a".repeat(32)}?account=1`))).toEqual({
        status: 404,
      });
    }));
});

describe("the account key", () => {
  it("is published for hosts, and is not a K3 key", () =>
    withAccounts(async (relay) => {
      const known = await relay.http("GET", "/.well-known/k3-relay");
      const tokens = new AccountTokens(decodeBase64url(TEST_SEED, 32)!);
      expect(known.json?.accounts).toEqual({
        providers: ["github", "google", "apple"],
        issuer: PUBLIC_URL,
        key: base64url(tokens.publicKey),
      });
    }));
});
