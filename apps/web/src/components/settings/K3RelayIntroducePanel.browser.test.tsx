import type { K3RelayIntroductionClaims } from "@t3tools/client-runtime/k3relay";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { K3RelayIntroduceView } from "./K3RelayIntroducePanel";

const host = (label: string) =>
  ({
    label,
    hostId: label.toLowerCase().padEnd(32, "a"),
  }) as unknown as K3RelayIntroductionClaims["claims"][number]["window"]["host"];

const window = (label: string) => ({
  host: host(label),
  introductionId: "i".repeat(22),
  expiresAt: 0,
});

describe("K3RelayIntroduceView", () => {
  it("shows one code for every host and approves only on the user's tap", async () => {
    const onApprove = vi.fn();
    const onCancel = vi.fn();
    const claims = {
      confirmationCode: "K7QM-2XFD",
      deviceName: "New tablet",
      claims: [
        { window: window("Studio"), claim: {} },
        { window: window("Laptop"), claim: {} },
      ],
      unclaimed: [window("Server")],
    } as unknown as K3RelayIntroductionClaims;
    await using screen = await render(
      <K3RelayIntroduceView
        phase={{ kind: "compare", session: {} as never, claims }}
        onStart={vi.fn()}
        onApprove={onApprove}
        onCancel={onCancel}
        onReset={vi.fn()}
      />,
    );
    const compare = screen.getByTestId("k3relay-introduce-compare");
    await expect
      .element(compare.getByText(/New tablet wants to join Studio, Laptop/))
      .toBeVisible();
    await expect.element(compare.getByText("K7QM-2XFD")).toBeVisible();
    await expect.element(compare.getByText(/did not reach Server/)).toBeVisible();
    expect(onApprove).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Approve" }).click();
    expect(onApprove).toHaveBeenCalledTimes(1);
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
