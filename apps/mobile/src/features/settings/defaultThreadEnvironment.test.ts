import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveDefaultThreadEnvironmentId } from "./defaultThreadEnvironment";

describe("resolveDefaultThreadEnvironmentId", () => {
  const known = EnvironmentId.make("environment:known");
  const isKnown = (id: EnvironmentId) => id === known;

  it("keeps a default that is still in the list", () => {
    expect(resolveDefaultThreadEnvironmentId(known, isKnown)).toBe(known);
  });

  it("treats a default missing from the list as Automatic", () => {
    expect(resolveDefaultThreadEnvironmentId(EnvironmentId.make("environment:gone"), isKnown)).toBe(
      null,
    );
  });

  it("treats an unset default as Automatic", () => {
    expect(resolveDefaultThreadEnvironmentId(null, isKnown)).toBe(null);
    expect(resolveDefaultThreadEnvironmentId(undefined, isKnown)).toBe(null);
  });
});
