import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildNewThreadLink,
  parseNewThreadLink,
  parseThreadLinkPrompt,
  promptLinkAppPath,
  promptLinkDeepLink,
  sanitizeLinkedPrompt,
  withoutPromptLinkParams,
} from "./promptLinks.ts";
import { hostedThreadLink } from "./threadLinks.ts";

describe("sanitizeLinkedPrompt", () => {
  it("removes characters a reader cannot see and counts them", () => {
    const tagged = "rate me" + String.fromCodePoint(0xe0041, 0xe0042);
    expect(sanitizeLinkedPrompt(`a\u200Bb\u202Ec\uFEFF${tagged}`)).toEqual({
      text: "abcrate me",
      hiddenCharacters: 5,
    });
    expect(sanitizeLinkedPrompt("a\u2028b\u2029c")).toEqual({
      text: "a\nb\nc",
      hiddenCharacters: 0,
    });
  });

  it("keeps emoji sequences intact", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const heart = "\u2764\uFE0F";
    expect(sanitizeLinkedPrompt(`${family} ${heart}`)).toEqual({
      text: `${family} ${heart}`,
      hiddenCharacters: 0,
    });
    expect(sanitizeLinkedPrompt("a\u200Db").hiddenCharacters).toBe(1);
    expect(sanitizeLinkedPrompt("\u{1F468}\u200D").hiddenCharacters).toBe(1);
    expect(sanitizeLinkedPrompt("\u{20000}\u200D\u{20001}").hiddenCharacters).toBe(1);
  });
});

describe("parseNewThreadLink", () => {
  it("reads a shared prompt with its optional repository and model", () => {
    const result = parseNewThreadLink(
      "?prompt=Rate+me&repo=https://github.com/pingdotgg/t3code.git&provider=Codex&model=gpt-5",
    );
    expect(result).toEqual({
      ok: true,
      value: {
        kind: "new",
        prompt: { text: "Rate me", hiddenCharacters: 0 },
        repository: { owner: "pingdotgg", name: "t3code" },
        provider: "codex",
        model: "gpt-5",
      },
    });
  });

  it("reads a pull request link, whose prompt is optional", () => {
    for (const pr of [
      "pingdotgg/t3code/42",
      "pingdotgg/t3code%2342",
      "https://github.com/pingdotgg/t3code/pull/42/files",
    ]) {
      expect(parseNewThreadLink(`?pr=${pr}`)).toEqual({
        ok: true,
        value: {
          kind: "pull-request",
          pullRequest: { owner: "pingdotgg", name: "t3code", number: 42 },
          prompt: null,
        },
      });
    }
  });

  it("refuses links it cannot open safely", () => {
    expect(parseNewThreadLink("?repo=a/b").ok).toBe(false);
    expect(parseNewThreadLink("?prompt=%E2%80%8B").ok).toBe(false);
    expect(parseThreadLinkPrompt("?prompt=%E2%80%8B").ok).toBe(false);
    expect(parseNewThreadLink("?prompt=x&repo=../etc").ok).toBe(false);
    expect(parseNewThreadLink(`?prompt=${"x".repeat(8_001)}`).ok).toBe(false);
  });
});

describe("thread links", () => {
  it("reads the prompt and leaves other parameters in place", () => {
    expect(parseThreadLinkPrompt("?prompt=Fix+it")).toEqual({
      ok: true,
      value: { text: "Fix it", hiddenCharacters: 0 },
    });
    expect(parseThreadLinkPrompt("?panel=diff")).toEqual({ ok: true, value: null });
    expect(withoutPromptLinkParams("?prompt=x&panel=diff")).toBe("?panel=diff");
  });
});

const HOSTED = "https://hosted.example.test";

describe("link round trips", () => {
  const prompt = {
    prompt: "Swear count & rating?",
    repository: { owner: "pingdotgg", name: "t3code" },
    provider: "claudeAgent",
    model: "opus",
  };

  it("builds a hosted link that parses back to the same prompt when a hosted app is configured", () => {
    const link = buildNewThreadLink({ ...prompt, origin: HOSTED });
    expect(new URL(link).origin).toBe(HOSTED);
    const path = promptLinkAppPath(link, HOSTED);
    expect(path).toBe(new URL(link).pathname + new URL(link).search);
    const parsed = parseNewThreadLink(new URL(link).search);
    expect(parsed.ok && parsed.value.kind === "new" && parsed.value.prompt.text).toBe(
      "Swear count & rating?",
    );
  });

  it("builds a k3code link, never a hosted one, when no hosted app is configured", () => {
    for (const origin of [undefined, null, "", "not a url", "http://insecure.example.test"]) {
      const link = buildNewThreadLink({ ...prompt, origin });
      expect(link.startsWith("k3code://new?prompt=")).toBe(true);
      expect(link).not.toContain("t3.codes");
      const path = promptLinkAppPath(link);
      expect(path).toBe(`/new${new URL(link).search}`);
      const parsed = parseNewThreadLink(new URL(link).search);
      expect(parsed.ok && parsed.value.kind === "new" && parsed.value.prompt.text).toBe(
        "Swear count & rating?",
      );
    }
    expect(buildNewThreadLink({ prompt: "hi", scheme: "k3code-dev" })).toBe(
      "k3code-dev://new?prompt=hi",
    );
  });

  it("opens a copied thread link in the app at that thread", () => {
    const ref = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("mcp:1") };
    const link = hostedThreadLink(ref, HOSTED);
    const path = promptLinkAppPath(link, HOSTED);
    expect(path).toBe("/env-1/mcp%3A1");
    const deepLink = promptLinkDeepLink(path!);
    expect(deepLink).toBe("k3code://threads/env-1/mcp%3A1");
    expect(promptLinkAppPath(deepLink)).toBe(path);
  });

  it("maps app scheme links to in-app paths without any hosted app", () => {
    expect(promptLinkAppPath("k3code://new?prompt=hi")).toBe("/new?prompt=hi");
    expect(promptLinkAppPath("k3code-dev://threads/env-1/thread-1")).toBe("/env-1/thread-1");
    expect(promptLinkAppPath("k3code://app/index.html")).toBeNull();
    // Without a configured hosted app no web address is a link, the former T3 one included.
    for (const hostedAppUrl of [undefined, null, "", "not a url"]) {
      expect(promptLinkAppPath("https://app.t3.codes/new?prompt=hi", hostedAppUrl)).toBeNull();
      expect(promptLinkAppPath(`${HOSTED}/new?prompt=hi`, hostedAppUrl)).toBeNull();
    }
    expect(promptLinkAppPath("https://app.t3.codes/new?prompt=hi", HOSTED)).toBeNull();
  });

  it("maps hosted links to in-app paths only for the configured hosted app", () => {
    expect(promptLinkAppPath(`${HOSTED}/env-1/thread-1?prompt=go`, HOSTED)).toBe(
      "/env-1/thread-1?prompt=go",
    );
    expect(promptLinkAppPath(`${HOSTED}/threads/env-1/thread-1`, HOSTED)).toBe("/env-1/thread-1");
    expect(promptLinkAppPath(`${HOSTED}/threads/env-1/thread-1?prompt=go`, HOSTED)).toBe(
      "/env-1/thread-1?prompt=go",
    );
    // The web app's own thread route, reloaded, is no link.
    expect(promptLinkAppPath(`${HOSTED}/env-1/thread-1`, HOSTED)).toBeNull();
    expect(promptLinkAppPath(`${HOSTED}/threads/env-1`, HOSTED)).toBeNull();
    expect(promptLinkAppPath(`${HOSTED}/settings/general`, HOSTED)).toBeNull();
    expect(promptLinkAppPath("https://evil.test/new?prompt=hi", HOSTED)).toBeNull();
  });

  it("maps links in browsers without URL.canParse, such as Safari before 17", () => {
    const canParse = URL.canParse;
    Reflect.deleteProperty(URL, "canParse");
    try {
      expect(promptLinkAppPath(`${HOSTED}/new?prompt=hi`, HOSTED)).toBe("/new?prompt=hi");
      expect(promptLinkAppPath(`${HOSTED}/`, HOSTED)).toBeNull();
      expect(promptLinkAppPath("not a url", HOSTED)).toBeNull();
    } finally {
      URL.canParse = canParse;
    }
  });
});
