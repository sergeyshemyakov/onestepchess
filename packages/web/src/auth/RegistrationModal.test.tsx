import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import type { VerifyResponse } from "../api/schemas.js";
import { metaFixture, mockClient, playerFixture } from "../test/fixtures.jsx";
import { RegistrationModal } from "./RegistrationModal.jsx";
import {
  resetTurnstileForTests,
  turnstileScriptRequested,
} from "./turnstile.js";

afterEach(() => {
  cleanup();
  resetTurnstileForTests();
});

function apiError(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
) {
  return new ApiError(
    status,
    {
      error: code,
      hint: `${code.toLowerCase().replaceAll("_", " ")}`,
      docs: "",
      ...extra,
    },
    null,
    new Headers(),
  );
}

function renderModal(resubmit: ReturnType<typeof vi.fn>) {
  const onRegistered = vi.fn();
  render(
    <RegistrationModal
      client={mockClient()}
      meta={metaFixture}
      pending={{ address: playerFixture.address, resubmit: resubmit as never }}
      onRegistered={onRegistered}
      onCancel={vi.fn()}
    />,
  );
  return { onRegistered };
}

async function submitOnce() {
  const button = await screen.findByRole("button", { name: /▸ register/ });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  fireEvent.click(button);
}

describe("registration modal error-rendering matrix (F-W2)", () => {
  it("renders brighter full-size registration actions with cancel aligned second", async () => {
    renderModal(vi.fn());
    const register = await screen.findByRole("button", { name: /▸ register/ });
    const cancel = screen.getByRole("button", { name: "cancel" });
    const actions = register.closest(".modal-actions");

    expect(register.className).toContain("pri");
    expect(register.className).not.toContain("mini");
    expect(cancel.className).not.toContain("mini");
    expect(actions?.className).toContain("pair");
    expect(actions?.lastElementChild).toBe(cancel);
  });

  it("styles the agent registration note as a prompt", async () => {
    renderModal(vi.fn());
    expect(
      await screen.findByText("> agents register over the API."),
    ).not.toBeNull();
  });

  it("prefills the nickname from suggest-nickname with a reroll control", async () => {
    renderModal(vi.fn());
    const input = await screen.findByLabelText("nickname");
    await waitFor(() =>
      expect((input as HTMLInputElement).value).toBe("gentle-rook-042"),
    );
    expect(
      screen.getByRole("button", { name: /reroll nickname/ }),
    ).not.toBeNull();
  });

  it("NICKNAME_TAKEN renders the hint plus a one-click suggestion", async () => {
    const resubmit = vi.fn(async () => {
      throw apiError(409, "NICKNAME_TAKEN", { suggestion: "brave-rook-7" });
    });
    renderModal(resubmit);
    await submitOnce();
    await screen.findByRole("alert");
    const use = screen.getByRole("button", { name: /use brave-rook-7/ });
    fireEvent.click(use);
    const input = screen.getByLabelText("nickname") as HTMLInputElement;
    expect(input.value).toBe("brave-rook-7");
  });

  it("INVALID_NICKNAME shows the rule inline", async () => {
    const resubmit = vi.fn(async () => {
      throw apiError(400, "INVALID_NICKNAME");
    });
    renderModal(resubmit);
    await submitOnce();
    await screen.findByRole("alert");
    expect(screen.getByText(/3–24 letters/)).not.toBeNull();
  });

  it("TURNSTILE_FAILED re-renders the widget and surfaces the hint", async () => {
    const resubmit = vi.fn(async () => {
      throw apiError(400, "TURNSTILE_FAILED");
    });
    renderModal(resubmit);
    await submitOnce();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("turnstile failed");
    // dev fixture path: the retry re-arms without ever loading the script
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /▸ register/ })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    expect(turnstileScriptRequested()).toBe(false);
  });

  it("success hands the player to onRegistered — the next render is the hub's", async () => {
    const response: VerifyResponse = { player: playerFixture, jwt: "jwt" };
    const resubmit = vi.fn(async () => response);
    const { onRegistered } = renderModal(resubmit);
    await submitOnce();
    await waitFor(() =>
      expect(onRegistered).toHaveBeenCalledWith(playerFixture),
    );
    expect(resubmit).toHaveBeenCalledWith({
      nickname: "gentle-rook-042",
      turnstileToken: expect.any(String),
    });
  });
});

describe("turnstile stays lazy (§4.8)", () => {
  it("no turnstile script is requested before/without the modal, and none in dev fixture mode", async () => {
    expect(turnstileScriptRequested()).toBe(false);
    renderModal(vi.fn());
    await screen.findByRole("dialog");
    expect(turnstileScriptRequested()).toBe(false);
    expect(
      document.querySelector('script[src*="challenges.cloudflare.com"]'),
    ).toBeNull();
  });
});
