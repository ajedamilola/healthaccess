import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "@/api/mocks/server";
import { createRecordHandlers } from "@/api/mocks/handlers/record";
import { meMedicalResponse } from "@/api/mocks/fixtures";
import { ONBOARDING_KEY, SetupWizard } from "@/features/onboarding/SetupWizard";
import { PersonalSection } from "@/features/record/PersonalSection";
import { renderWithProviders } from "./utils";

configure({ asyncUtilTimeout: 5000 });

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

beforeEach(() => {
  server.use(...createRecordHandlers());
  navigation.replace.mockClear();
  window.localStorage.clear();
});

describe("SetupWizard", () => {
  it("can be skipped entirely from the welcome screen", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SetupWizard nextPath="/app" />);
    expect(await screen.findByRole("heading", { name: "Welcome, Demo!" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(navigation.replace).toHaveBeenCalledWith("/app");
    expect(window.localStorage.getItem(ONBOARDING_KEY)).toBe("skipped");
  });

  it("never redirects to another origin", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SetupWizard nextPath="//evil.example" />);
    await user.click(await screen.findByRole("button", { name: "Skip for now" }));
    expect(navigation.replace).toHaveBeenCalledWith("/app");
  });

  it("saves each step, allows skipping steps and finishes", async () => {
    const patches: Record<string, unknown>[] = [];
    const puts: Record<string, unknown>[] = [];
    server.use(
      http.patch("/api/v1/me", async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(meMedicalResponse);
      }),
      http.put("/api/v1/me/medical", async ({ request }) => {
        puts.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(meMedicalResponse);
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<SetupWizard nextPath="/app" />);
    await user.click(await screen.findByRole("button", { name: "Get started" }));

    expect(screen.getByText("Step 1 of 4")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-04-02" } });
    await user.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(await screen.findByText("Step 2 of 4")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("City or town"), { target: { value: "Ikeja" } });
    fireEvent.change(screen.getByLabelText("State or region"), { target: { value: "Lagos" } });
    await user.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(await screen.findByText("Step 3 of 4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip this step" }));

    expect(await screen.findByText("Step 4 of 4")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Contact phone"), { target: { value: "0801" } });
    await user.click(screen.getByRole("button", { name: "Save and finish" }));
    expect(await screen.findByText(/full number with country code/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Contact phone"), { target: { value: "+2348012345678" } });
    await user.click(screen.getByRole("button", { name: "Save and finish" }));

    expect(await screen.findByRole("heading", { name: "You're all set" })).toBeInTheDocument();
    expect(patches).toEqual([{ dob: "1990-04-02" }, { city: "Ikeja", state: "Lagos" }]);
    expect(puts).toEqual([{ emergencyContactName: "Ada", emergencyContactPhone: "+2348012345678" }]);
    expect(window.localStorage.getItem(ONBOARDING_KEY)).toBe("done");

    await user.click(screen.getByRole("button", { name: "Talk to the assistant" }));
    expect(navigation.replace).toHaveBeenCalledWith("/app/assistant");
  }, 20_000);

  it("offers Skip setup on every step", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SetupWizard nextPath="/app/record" />);
    await user.click(await screen.findByRole("button", { name: "Get started" }));
    await user.click(screen.getByRole("button", { name: "Skip setup" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/app/record"));
  });
});

describe("PersonalSection", () => {
  it("sends only changed personal details and reports the matched area", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.patch("/api/v1/me", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          ...meMedicalResponse,
          field_values: { ...meMedicalResponse.field_values, city: "Ikeja", state: "Lagos" },
          profile: {
            ...meMedicalResponse.profile,
            home_area: { id: "20000000-0000-4000-8000-000000000001", name: "Ikeja", city: "Ikeja", region: "Lagos", country_code: "NG" },
          },
        });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<PersonalSection me={meMedicalResponse} />);
    expect(screen.getByRole("button", { name: "Save details" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("City or town"), { target: { value: "Ikeja" } });
    fireEvent.change(screen.getByLabelText("State or region"), { target: { value: "Lagos" } });
    await user.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByText("Saved. Your area is set to Ikeja, Lagos.")).toBeInTheDocument();
    expect(body).toEqual({ city: "Ikeja", state: "Lagos" });
  });
});

describe("SetupWizard health step", () => {
  it("keeps existing allergy severity and diagnosis dates when adding one", async () => {
    let put: { allergies?: Array<Record<string, unknown>> } | undefined;
    const withDated = {
      ...meMedicalResponse,
      allergies: [
        {
          id: "40000000-0000-4000-8000-000000000001",
          name: "Peanuts",
          severity: "SEVERE",
          diagnosis_date: "2019-04-01T00:00:00.000Z",
        },
      ],
    };
    server.use(
      http.get("/api/v1/me", () => HttpResponse.json(withDated)),
      http.patch("/api/v1/me", () => HttpResponse.json(withDated)),
      http.put("/api/v1/me/medical", async ({ request }) => {
        put = (await request.json()) as typeof put;
        return HttpResponse.json(withDated);
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<SetupWizard nextPath="/app" />);
    await user.click(await screen.findByRole("button", { name: "Get started" }));
    await user.click(screen.getByRole("button", { name: "Skip this step" }));
    await user.click(await screen.findByRole("button", { name: "Skip this step" }));
    const input = await screen.findByLabelText("Allergies");
    await user.type(input, "Latex{Enter}");
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(put).toBeDefined());
    expect(put!.allergies).toEqual([
      { name: "Peanuts", severity: "SEVERE", diagnosisDate: "2019-04-01" },
      { name: "Latex" },
    ]);
  });
});
