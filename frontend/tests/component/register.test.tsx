import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import { server } from "@/api/mocks/server";
import { registerSession } from "@/api/mocks/fixtures";
import { RegisterForm } from "@/features/auth/RegisterForm";
import { renderWithProviders } from "./utils";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("First name"), "Ada");
  await user.type(screen.getByLabelText("Last name"), "Okafor");
  await user.type(screen.getByLabelText("Email"), "ada.okafor@example.test");
  await user.type(screen.getByLabelText("Password"), "DemoPass123!");
  await user.type(screen.getByLabelText("Confirm password"), "DemoPass123!");
}

describe("RegisterForm", () => {
  it("shows a confirmation error and keeps the draft", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RegisterForm nextPath="/app" />);

    await user.type(screen.getByLabelText("First name"), "Ada");
    await user.type(screen.getByLabelText("Last name"), "Okafor");
    await user.type(screen.getByLabelText("Email"), "ada.okafor@example.test");
    await user.type(screen.getByLabelText("Password"), "DemoPass123!");
    await user.type(screen.getByLabelText("Confirm password"), "Different123!");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Passwords do not match")).toBeInTheDocument();
    expect(screen.getByLabelText("First name")).toHaveValue("Ada");
  });

  it("maps email_taken to the email field", async () => {
    const user = userEvent.setup();
    server.use(http.post("/api/auth/register", () => HttpResponse.json({ error: "email_taken" }, { status: 409 })));

    renderWithProviders(<RegisterForm nextPath="/app" />);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("This email is already registered.")).toBeInTheDocument();
  });

  it("shows pending and redirects after creating the account", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/auth/register", async () => {
        await delay(50);
        return HttpResponse.json(registerSession, { status: 201 });
      }),
    );

    renderWithProviders(<RegisterForm nextPath="/app" />);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("button", { name: "Create account" })).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/app/welcome?next=%2Fapp"));
  });
});
