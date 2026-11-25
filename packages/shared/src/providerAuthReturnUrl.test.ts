import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["k3code", "k3code-dev"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it("allows this machine, and the hosted app only when one is configured", () => {
    const loopback = "http://127.0.0.1:5733/settings/providers?instanceId=work";
    expect(providerAuthReturnUrl(loopback)).toBe(loopback);
    const hosted = "https://hosted.example.test/settings/providers?instanceId=work";
    expect(providerAuthReturnUrl(hosted)).toBeUndefined();
    expect(providerAuthReturnUrl(hosted, undefined)).toBeUndefined();
    expect(providerAuthReturnUrl(hosted, "https://hosted.example.test")).toBe(hosted);
    expect(providerAuthReturnUrl(hosted, "https://hosted.example.test/ignored/path")).toBe(hosted);
    expect(providerAuthReturnUrl(hosted, "https://other.example.test")).toBeUndefined();
    expect(providerAuthReturnUrl(hosted, "http://hosted.example.test")).toBeUndefined();
  });
  it("never treats the former T3 hosted app as a return destination", () => {
    for (const hostedAppUrl of [undefined, "https://hosted.example.test"]) {
      expect(
        providerAuthReturnUrl("https://app.t3.codes/welcome#agents:machine-id", hostedAppUrl),
      ).toBeUndefined();
    }
  });
  it.each([
    "k3code://attacker/welcome",
    "k3code://app/welcome/../evil",
    "https://attacker.example/welcome",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());
});
