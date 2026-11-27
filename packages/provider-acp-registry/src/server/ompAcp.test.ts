import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import { describe, expect, it } from "vite-plus/test";

import { extractOmpElicitationForm } from "./ompAcp.ts";

type ElicitationRequest = Parameters<NonNullable<AcpAdapterV2Flavor["extractElicitationForm"]>>[0];

const form = extractOmpElicitationForm({
  mode: "form",
  sessionId: "session-id",
  message: "Answer 1 question",
  requestedSchema: {
    type: "object",
    properties: {
      q0: {
        type: "string",
        title: "Deploy to staging first?",
        oneOf: [
          { const: "yes", title: "Yes" },
          { const: "no", title: "No" },
        ],
      },
      q0__other: { type: "string", title: "Other (type your own)" },
    },
  },
} as ElicitationRequest);

describe("extractOmpElicitationForm", () => {
  it("sends a choice to its field and free text to the companion", () => {
    expect(form?.respond({ q0: "yes" })).toEqual({ action: "accept", content: { q0: "yes" } });
    expect(form?.respond({ q0: "Fridays only" })).toEqual({
      action: "accept",
      content: { q0__other: "Fridays only" },
    });
  });

  it("fills both fields when a note is typed beside the choice", () => {
    expect(
      form?.respond(
        { q0: "yes\nafter the backup" },
        { q0: { answer: "yes", note: "after the backup" } },
      ),
    ).toEqual({ action: "accept", content: { q0: "yes", q0__other: "after the backup" } });
  });
});
