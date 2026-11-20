import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "@/api/mocks/server";
import { OpenCodeScreen } from "@/features/sharing/OpenCodeScreen";
import { QuickShareCard } from "@/features/sharing/QuickShareCard";
import { renderWithProviders } from "./utils";

configure({ asyncUtilTimeout: 5000 });

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

const SESSION = "6b0b6c63-62d5-4a42-9b9a-1f2a8f1b0c11";

beforeEach(() => navigation.push.mockClear());

describe("OpenCodeScreen", () => {
  it("opens a 12-digit emergency code in one box and shows the fields", async () => {
    let body: unknown;
    server.use(
      http.post("/api/v1/records/open", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          kind: "emergency",
          available: true,
          fields: [{ key: "allergies", label: "Allergies", value: ["Penicillin"] }],
        });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<OpenCodeScreen />);
    const box = screen.getByLabelText("Access code");
    fireEvent.change(box, { target: { value: "1234-5678 9012" } });
    expect(box).toHaveValue("1234 5678 9012");
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("Penicillin")).toBeInTheDocument();
    expect(body).toEqual({ code: "123456789012" });
  });

  it("opens an 8-digit temporary code straight into the shared record", async () => {
    server.use(
      http.post("/api/v1/records/open", () =>
        HttpResponse.json({
          kind: "grant",
          available: true,
          fields: [{ key: "blood_group", label: "Blood group", value: "O+" }],
          grant_id: "8f8b4a2e-6e7c-4c1c-9b5b-0f9d2b0e3a11",
          read_session_id: SESSION,
          expires_at: "2026-11-18T13:00:00.000Z",
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<OpenCodeScreen />);
    fireEvent.change(screen.getByLabelText("Access code"), { target: { value: "87654321" } });
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith(`/practitioner/records/${SESSION}`));
  });

  it("explains that temporary codes are for practitioners", async () => {
    server.use(
      http.post("/api/v1/records/open", () =>
        HttpResponse.json({ error: "practitioner_required", message: "x" }, { status: 403 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<OpenCodeScreen />);
    fireEvent.change(screen.getByLabelText("Access code"), { target: { value: "87654321" } });
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("This code is for verified practitioners")).toBeInTheDocument();
  });

  it("validates the length and reports codes that do not work", async () => {
    let posts = 0;
    server.use(
      http.post("/api/v1/records/open", () => {
        posts += 1;
        return HttpResponse.json({ available: false });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<OpenCodeScreen />);
    fireEvent.change(screen.getByLabelText("Access code"), { target: { value: "12345" } });
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText(/Enter the full code/)).toBeInTheDocument();
    expect(posts).toBe(0);

    fireEvent.change(screen.getByLabelText("Access code"), { target: { value: "11112222" } });
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("That code did not work")).toBeInTheDocument();
  });
});

describe("QuickShareCard", () => {
  it("creates one code in one tap with the chosen duration", async () => {
    let body: unknown;
    server.use(
      http.post("/api/v1/me/grants/quick", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          {
            available: true,
            id: "8f8b4a2e-6e7c-4c1c-9b5b-0f9d2b0e3a11",
            grant_id: "8f8b4a2e-6e7c-4c1c-9b5b-0f9d2b0e3a11",
            code: "48219367",
            expires_at: "2026-11-19T12:00:00.000Z",
            created_at: "2026-11-18T12:00:00.000Z",
            field_keys: ["allergies"],
            channels: ["WEB_PRACTITIONER", "USSD"],
          },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<QuickShareCard />);
    await user.click(screen.getByRole("button", { name: "24 hours" }));
    await user.click(screen.getByRole("button", { name: "Create a code" }));
    expect(await screen.findByText("4821 9367")).toBeInTheDocument();
    expect(body).toEqual({ expires_in_minutes: 1440 });
  });

  it("guides the patient when there is nothing to share", async () => {
    server.use(
      http.post("/api/v1/me/grants/quick", () =>
        HttpResponse.json({ error: "nothing_to_share", message: "x" }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<QuickShareCard />);
    await user.click(screen.getByRole("button", { name: "Create a code" }));
    expect(await screen.findByText("Nothing to share yet")).toBeInTheDocument();
  });
});
