import type { ProviderAuthMethod } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ChatGptAccountPicker } from "./ChatGptAccountPicker";

const incomplete: ProviderAuthMethod = {
  id: "chatgpt-profile:oaiapp_incomplete",
  name: "ChatGPT account · Connection 1",
  description: null,
  type: "agent",
  canRemove: true,
};
const verified: ProviderAuthMethod = {
  id: "chatgpt-profile:oaiapp_verified",
  name: "dev@example.com · Connection 2",
  accountEmail: "dev@example.com",
  description: null,
  type: "agent",
  canRemove: false,
};

const renderPicker = (methods: readonly ProviderAuthMethod[], onSelect: (id: string) => void) =>
  render(
    <ChatGptAccountPicker
      open
      methods={methods}
      onClose={() => {}}
      onSelect={onSelect}
      onRemove={() => {}}
      disabled={false}
      canRemove
      error={null}
    />,
  );

it("preselects a verified connection over a newer incomplete one", async () => {
  const onSelect = vi.fn();
  await using _screen = await renderPicker([incomplete, verified], onSelect);

  await page.getByRole("button", { name: "Continue with ChatGPT" }).click();

  expect(onSelect).toHaveBeenCalledWith(verified.id);
});

it("starts a new connection when only incomplete ones are saved", async () => {
  const onSelect = vi.fn();
  await using _screen = await renderPicker([incomplete], onSelect);

  await page.getByRole("button", { name: "Continue with ChatGPT" }).click();

  expect(onSelect).toHaveBeenCalledWith("chatgpt-change-account");
});
