import { describe, expect, it } from "vite-plus/test";

import { hostedAppOrigin } from "./hostedApp.ts";

describe("hostedAppOrigin", () => {
  it("is undefined when no hosted app is configured", () => {
    for (const value of [undefined, null, "", "   "]) {
      expect(hostedAppOrigin(value)).toBeUndefined();
    }
  });

  it("keeps only the origin of an HTTPS or HTTP loopback URL", () => {
    expect(hostedAppOrigin(" https://app.example.com/some/path?x=1#y ")).toBe(
      "https://app.example.com",
    );
    expect(hostedAppOrigin("http://localhost:5733")).toBe("http://localhost:5733");
    expect(hostedAppOrigin("http://127.0.0.1:5733/")).toBe("http://127.0.0.1:5733");
    expect(hostedAppOrigin("http://[::1]:5733/")).toBe("http://[::1]:5733");
  });

  it("rejects anything that is not a secure or loopback origin", () => {
    for (const value of [
      "app.example.com",
      "http://app.example.com",
      "http://0.0.0.0:5733",
      "ftp://app.example.com",
      "k3code://app",
      "javascript:alert(1)",
    ]) {
      expect(hostedAppOrigin(value), value).toBeUndefined();
    }
  });
});
