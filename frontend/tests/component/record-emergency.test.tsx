import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { server } from "@/api/mocks/server";
import { createRecordHandlers } from "@/api/mocks/handlers/record";
import {
  emergencyFieldsResponse,
  emergencySummaryEmpty,
  fieldsConflict,
  fieldsResponse,
} from "@/api/mocks/fixtures";
import { EmergencySummaryScreen } from "@/features/record/EmergencySummaryScreen";
import { renderWithProviders } from "./utils";

function summaryFor(keys: string[]) {
  return {
    available: keys.length > 0,
    version: 3,
    field_keys: keys,
    fields: keys
      .map((key) => fieldsResponse.fields.find((field) => field.key === key))
      .filter((field): field is (typeof fieldsResponse.fields)[number] => Boolean(field))
      .map((field) => ({ key: field.key, label: field.label, value: field.value })),
  };
}

describe("EmergencySummaryScreen", () => {
  beforeEach(() => {
    server.use(...createRecordHandlers());
  });

  it("shows a skeleton while the selection loads", async () => {
    server.use(
      http.get("/api/v1/me/fields", async () => {
        await delay(40);
        return HttpResponse.json(fieldsResponse);
      }),
    );

    renderWithProviders(<EmergencySummaryScreen />);
    expect(await screen.findByRole("status", { name: "Loading your emergency summary" })).toBeInTheDocument();
    expect(await screen.findByText("Fields in your emergency summary")).toBeInTheDocument();
  });

  it("shows the checklist and the confirmed preview in the saved order", async () => {
    renderWithProviders(<EmergencySummaryScreen />);

    const preview = await screen.findByRole("list", { name: "Emergency preview fields" });
    const items = within(preview).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "NameBola Adeyemi",
      "AllergiesPenicillin",
      "MedicationsParacetamol as needed",
      "Blood groupO+",
      "Contact nameTunde Adeyemi",
    ]);
    expect(screen.getByText("Confirmed by the server")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Name" })).toBeChecked();
    expect(screen.getAllByText("Not shareable in an emergency").length).toBeGreaterThan(0);
  });

  it("removes a field from the preview and saves the remaining order", async () => {
    const user = userEvent.setup();
    let body: { field_keys: string[]; expected_version: number } | undefined;
    server.use(
      http.put("/api/v1/me/emergency-fields", async ({ request }) => {
        body = (await request.json()) as { field_keys: string[]; expected_version: number };
        return HttpResponse.json({ version: 3, field_keys: body.field_keys });
      }),
    );

    renderWithProviders(<EmergencySummaryScreen />);
    const allergies = await screen.findByRole("checkbox", { name: "Allergies" });
    expect(allergies).toBeChecked();

    await user.click(allergies);

    const preview = screen.getByRole("list", { name: "Emergency preview fields" });
    expect(within(preview).queryByText("Allergies")).not.toBeInTheDocument();
    expect(within(preview).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("Unsaved selection")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save emergency summary" }));

    expect(await screen.findByText("Emergency summary updated. A code lookup reveals 4 fields.")).toBeInTheDocument();
    expect(body).toEqual({
      field_keys: ["full_name", "current_medications", "blood_group", "emergency_contact_name"],
      expected_version: 2,
    });
  });

  it("confirms before turning sharing off with an empty selection", async () => {
    const user = userEvent.setup();
    let putCalls = 0;
    let body: { field_keys: string[] } | undefined;
    server.use(
      http.put("/api/v1/me/emergency-fields", async ({ request }) => {
        putCalls += 1;
        body = (await request.json()) as { field_keys: string[] };
        return HttpResponse.json({ version: 3, field_keys: [] });
      }),
    );

    renderWithProviders(<EmergencySummaryScreen />);
    await screen.findByRole("checkbox", { name: "Name" });
    for (const key of emergencyFieldsResponse.field_keys) {
      const label = fieldsResponse.fields.find((field) => field.key === key)?.label ?? key;
      await user.click(screen.getByRole("checkbox", { name: label }));
    }

    await user.click(screen.getByRole("button", { name: "Save emergency summary" }));
    expect(screen.getByRole("dialog", { name: "Turn off emergency sharing?" })).toBeInTheDocument();
    expect(putCalls).toBe(0);

    await user.click(screen.getByRole("button", { name: "Turn off sharing" }));
    await waitFor(() => expect(putCalls).toBe(1));
    expect(body?.field_keys).toEqual([]);
    expect(
      await screen.findByText("Emergency sharing is off. A code lookup reveals nothing."),
    ).toBeInTheDocument();
  });

  it("shows the empty selection state when nothing is shared", async () => {
    server.use(http.get("/api/v1/me/emergency-summary", () => HttpResponse.json(emergencySummaryEmpty)));
    renderWithProviders(<EmergencySummaryScreen />);

    expect(await screen.findByText("Nothing is shared in an emergency")).toBeInTheDocument();
    expect(
      screen.getByText("No information is shared in an emergency. A code lookup returns nothing for your account."),
    ).toBeInTheDocument();
  });

  it("shows no eligible fields when every field is unavailable", async () => {
    const ineligible = {
      version: 2,
      fields: fieldsResponse.fields.map((field) => ({ ...field, emergency_eligible: false })),
    };
    server.use(
      http.get("/api/v1/me/fields", () => HttpResponse.json(ineligible)),
      http.get("/api/v1/me/emergency-summary", () =>
        HttpResponse.json({ available: false, version: 2, field_keys: [], fields: [] }),
      ),
    );

    renderWithProviders(<EmergencySummaryScreen />);
    expect(await screen.findByText("No fields can be shared yet")).toBeInTheDocument();
    expect(screen.getAllByText("Not shareable in an emergency").length).toBeGreaterThan(0);
  });

  it("marks an eligible field without a value as needing one first", async () => {
    server.use(
      http.get("/api/v1/me/fields", () =>
        HttpResponse.json({
          version: 2,
          fields: fieldsResponse.fields.map((field) =>
            field.key === "blood_pressure"
              ? { ...field, emergency_eligible: true, value: null, field_version: null }
              : field,
          ),
        }),
      ),
      http.get("/api/v1/me/emergency-summary", () => HttpResponse.json(emergencySummaryEmpty)),
    );

    renderWithProviders(<EmergencySummaryScreen />);
    const checkbox = await screen.findByRole("checkbox", { name: "Blood pressure" });
    expect(checkbox).toBeDisabled();
    expect(screen.getByText("Add a value first")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add a value on My record" })).toHaveAttribute(
      "href",
      "/app/record",
    );
  });

  it("shows a denied state without a retry", async () => {
    server.use(
      http.get("/api/v1/me/fields", () =>
        HttpResponse.json({ error: "forbidden", message: "Patient record access denied" }, { status: 403 }),
      ),
    );

    renderWithProviders(<EmergencySummaryScreen />);
    expect(await screen.findByText("You cannot open this right now")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("offers a retry after a failed load", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    server.use(
      http.get("/api/v1/me/emergency-summary", () => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json({ error: "upstream_unavailable", request_id: "req-emergency" }, { status: 500 });
        }
        return HttpResponse.json(summaryFor(emergencyFieldsResponse.field_keys));
      }),
    );

    renderWithProviders(<EmergencySummaryScreen />);
    expect(await screen.findByText("Could not load your emergency summary")).toBeInTheDocument();
    expect(screen.getByText("Request ID req-emergency")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Emergency preview fields" })).toBeInTheDocument();
  });

  it("keeps the selection on a version conflict and re-submits with the new version", async () => {
    const user = userEvent.setup();
    let getFields = 0;
    const putBodies: Array<{ field_keys: string[]; expected_version: number }> = [];

    server.use(
      http.get("/api/v1/me/fields", () => {
        getFields += 1;
        return HttpResponse.json(
          getFields === 1 ? fieldsResponse : { ...fieldsResponse, version: 3 },
        );
      }),
      http.get("/api/v1/me/emergency-summary", () =>
        HttpResponse.json(summaryFor(emergencyFieldsResponse.field_keys)),
      ),
      http.put("/api/v1/me/emergency-fields", async ({ request }) => {
        const body = (await request.json()) as { field_keys: string[]; expected_version: number };
        putBodies.push(body);
        if (putBodies.length === 1) return HttpResponse.json(fieldsConflict, { status: 409 });
        return HttpResponse.json({ version: 4, field_keys: body.field_keys });
      }),
    );

    renderWithProviders(<EmergencySummaryScreen />);
    const allergies = await screen.findByRole("checkbox", { name: "Allergies" });
    await user.click(allergies);
    await user.click(screen.getByRole("button", { name: "Save emergency summary" }));

    expect(await screen.findByText("This record changed since you opened it")).toBeInTheDocument();
    expect(screen.getByText("Saved by the server")).toBeInTheDocument();
    expect(screen.getByText("Your selection")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Use my changes" }));
    await waitFor(() => expect(putBodies).toHaveLength(2));
    expect(putBodies[1]?.expected_version).toBe(3);
    expect(putBodies[1]?.field_keys).not.toContain("allergies");
  });

  it("shows an inline error when the API rejects a selected field", async () => {
    const user = userEvent.setup();
    server.use(
      http.put("/api/v1/me/emergency-fields", () =>
        HttpResponse.json({ error: "invalid_field", message: "A field cannot be shared", request_id: "req-field" }, { status: 400 }),
      ),
    );

    renderWithProviders(<EmergencySummaryScreen />);
    await user.click(await screen.findByRole("checkbox", { name: "Allergies" }));
    await user.click(screen.getByRole("button", { name: "Save emergency summary" }));

    expect(await screen.findByText("Could not save your changes")).toBeInTheDocument();
    expect(screen.getByText("One of these fields cannot be edited.")).toBeInTheDocument();
    expect(screen.getByText("Request ID req-field")).toBeInTheDocument();
  });

  it("keeps the selection and never shows saved when a save fails, then retries", async () => {
    const user = userEvent.setup();
    let puts = 0;
    server.use(
      http.put("/api/v1/me/emergency-fields", async ({ request }) => {
        puts += 1;
        const body = (await request.json()) as { field_keys: string[] };
        if (puts === 1) {
          return HttpResponse.json(
            { error: "internal_error", message: "Something went wrong", request_id: "req-em" },
            { status: 500 },
          );
        }
        return HttpResponse.json({ version: 4, field_keys: body.field_keys });
      }),
    );

    renderWithProviders(<EmergencySummaryScreen />);
    const allergies = await screen.findByRole("checkbox", { name: "Allergies" });
    await user.click(allergies);
    await user.click(screen.getByRole("button", { name: "Save emergency summary" }));

    expect(await screen.findByText("Could not save your changes")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Allergies" })).not.toBeChecked();
    expect(screen.getByText("Unsaved selection")).toBeInTheDocument();
    expect(screen.queryByText(/Emergency summary updated/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Emergency summary updated/)).toBeInTheDocument();
    expect(puts).toBe(2);
  });

  it("refetches the selection before offering a retry after a timeout", async () => {
    const user = userEvent.setup();
    let gets = 0;
    server.use(
      http.get("/api/v1/me/fields", () => {
        gets += 1;
        return HttpResponse.json(fieldsResponse);
      }),
      http.put("/api/v1/me/emergency-fields", () =>
        HttpResponse.json(
          { error: "upstream_timeout", message: "The save timed out", request_id: "req-timeout" },
          { status: 504 },
        ),
      ),
    );

    renderWithProviders(<EmergencySummaryScreen />);
    const allergies = await screen.findByRole("checkbox", { name: "Allergies" });
    await user.click(allergies);
    await user.click(screen.getByRole("button", { name: "Save emergency summary" }));

    expect(await screen.findByText("This took too long.")).toBeInTheDocument();
    expect(gets).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("checkbox", { name: "Allergies" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText(/Emergency summary updated/)).not.toBeInTheDocument();
  });
});
