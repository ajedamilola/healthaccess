import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { server } from "@/api/mocks/server";
import { createRecordHandlers } from "@/api/mocks/handlers/record";
import {
  fieldsConflict,
  fieldsEmpty,
  fieldsResponse,
} from "@/api/mocks/fixtures";
import { RecordScreen } from "@/features/record/RecordScreen";
import { renderWithProviders } from "./utils";

function fieldsWith(overrides: Record<string, string | string[]>, version: number) {
  return {
    version,
    fields: fieldsResponse.fields.map((field) =>
      Object.prototype.hasOwnProperty.call(overrides, field.key)
        ? { ...field, value: overrides[field.key] }
        : field,
    ),
  };
}

describe("RecordScreen", () => {
  beforeEach(() => {
    server.use(...createRecordHandlers());
  });

  it("shows a skeleton while the record loads, then the fields by value type", async () => {
    server.use(
      http.get("/api/v1/me/fields", async () => {
        await delay(40);
        return HttpResponse.json(fieldsResponse);
      }),
    );

    renderWithProviders(<RecordScreen />);
    expect(await screen.findByRole("status", { name: "Loading your record" })).toBeInTheDocument();

    expect(await screen.findByLabelText("Name")).toHaveValue("Bola Adeyemi");
    expect(screen.getByLabelText("Allergies")).toBeInTheDocument();
    expect(screen.getByLabelText("Weight")).toHaveValue("64");
    expect(screen.getAllByText(/New fields are private until you choose to share them/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Emergency eligible").length).toBeGreaterThan(0);
  });

  it("saves only the changed keys with expected_version and announces the save", async () => {
    const user = userEvent.setup();
    let body: { fields: Record<string, unknown>; expected_version: number } | undefined;
    server.use(
      http.put("/api/v1/me/fields", async ({ request }) => {
        body = (await request.json()) as { fields: Record<string, unknown>; expected_version: number };
        return HttpResponse.json(fieldsWith({ full_name: "Ada Okafor" }, 3));
      }),
    );

    renderWithProviders(<RecordScreen />);
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Ada Okafor");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Record saved.")).toBeInTheDocument();
    expect(body?.expected_version).toBe(2);
    expect(body?.fields).toEqual({ full_name: "Ada Okafor" });
  });

  it("shows an empty state when there are no fields", async () => {
    server.use(http.get("/api/v1/me/fields", () => HttpResponse.json(fieldsEmpty)));
    renderWithProviders(<RecordScreen />);

    expect(await screen.findByText("No fields to edit yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to overview" })).toHaveAttribute("href", "/app");
  });

  it("maps validation issues onto the field and focuses it", async () => {
    const user = userEvent.setup();
    server.use(
      http.put("/api/v1/me/fields", () =>
        HttpResponse.json(
          {
            error: "validation_error",
            request_id: "req-validation",
            issues: [{ path: "fields.full_name", message: "Enter a valid name" }],
          },
          { status: 400 },
        ),
      ),
    );

    renderWithProviders(<RecordScreen />);
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "X");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Enter a valid name")).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(name).toHaveFocus());
  });

  it("shows a denied state without a retry when the record is forbidden", async () => {
    server.use(
      http.get("/api/v1/me/fields", () =>
        HttpResponse.json({ error: "forbidden", message: "Patient record access denied" }, { status: 403 }),
      ),
    );

    renderWithProviders(<RecordScreen />);
    expect(await screen.findByText("You cannot open this right now")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("offers a retry after a failed load", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    server.use(
      http.get("/api/v1/me/fields", () => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json(
            { error: "upstream_unavailable", request_id: "req-retry" },
            { status: 500 },
          );
        }
        return HttpResponse.json(fieldsResponse);
      }),
    );

    renderWithProviders(<RecordScreen />);
    expect(await screen.findByText("Could not load your record")).toBeInTheDocument();
    expect(screen.getByText("Request ID req-retry")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Name")).toHaveValue("Bola Adeyemi");
  });

  it("keeps the draft on a version conflict, shows both values, and re-submits with the new version", async () => {
    const user = userEvent.setup();
    let getAttempts = 0;
    const putBodies: Array<{ fields: Record<string, unknown>; expected_version: number }> = [];

    server.use(
      http.get("/api/v1/me/fields", () => {
        getAttempts += 1;
        return HttpResponse.json(
          getAttempts === 1 ? fieldsResponse : fieldsWith({ full_name: "Server Name" }, 3),
        );
      }),
      http.put("/api/v1/me/fields", async ({ request }) => {
        const body = (await request.json()) as { fields: Record<string, unknown>; expected_version: number };
        putBodies.push(body);
        if (putBodies.length === 1) {
          return HttpResponse.json(fieldsConflict, { status: 409 });
        }
        return HttpResponse.json(fieldsWith({ full_name: "My Name" }, 4));
      }),
    );

    renderWithProviders(<RecordScreen />);
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "My Name");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("This record changed since you opened it")).toBeInTheDocument();
    expect(screen.getByText("Server Name")).toBeInTheDocument();
    expect(screen.getByText("My Name")).toBeInTheDocument();
    expect(name).toHaveValue("My Name");

    await user.click(screen.getByRole("button", { name: "Use my changes" }));

    expect(await screen.findByText("Record saved.")).toBeInTheDocument();
    expect(putBodies[1]).toEqual({
      fields: { full_name: "My Name" },
      expected_version: 3,
    });
  });

  it("can discard a conflicting draft and show the refreshed values", async () => {
    const user = userEvent.setup();
    let getAttempts = 0;
    server.use(
      http.get("/api/v1/me/fields", () => {
        getAttempts += 1;
        return HttpResponse.json(
          getAttempts === 1 ? fieldsResponse : fieldsWith({ full_name: "Server Name" }, 3),
        );
      }),
      http.put("/api/v1/me/fields", () => HttpResponse.json(fieldsConflict, { status: 409 })),
    );

    renderWithProviders(<RecordScreen />);
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "My Name");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("This record changed since you opened it")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discard my changes" }));

    expect(await screen.findByText(/Your draft was discarded/)).toBeInTheDocument();
    expect(name).toHaveValue("Server Name");
    expect(screen.queryByText("This record changed since you opened it")).not.toBeInTheDocument();
  });

  it("keeps the draft and never shows saved when a save fails, then retries", async () => {
    const user = userEvent.setup();
    let puts = 0;
    server.use(
      http.put("/api/v1/me/fields", () => {
        puts += 1;
        if (puts === 1) {
          return HttpResponse.json(
            { error: "internal_error", message: "Something went wrong", request_id: "req-save" },
            { status: 500 },
          );
        }
        return HttpResponse.json(fieldsWith({ full_name: "Ada Okafor" }, 3));
      }),
    );

    renderWithProviders(<RecordScreen />);
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Ada Okafor");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Could not save your changes")).toBeInTheDocument();
    expect(screen.getByText("Request ID req-save")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Ada Okafor");
    expect(screen.queryByText("Record saved.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Record saved.")).toBeInTheDocument();
    expect(puts).toBe(2);
  });

  it("refetches the record before offering a retry after a timeout", async () => {
    const user = userEvent.setup();
    let gets = 0;
    server.use(
      http.get("/api/v1/me/fields", () => {
        gets += 1;
        return HttpResponse.json(fieldsResponse);
      }),
      http.put("/api/v1/me/fields", () =>
        HttpResponse.json(
          { error: "upstream_timeout", message: "The save timed out", request_id: "req-timeout" },
          { status: 504 },
        ),
      ),
    );

    renderWithProviders(<RecordScreen />);
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Ada Okafor");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("This took too long.")).toBeInTheDocument();
    expect(gets).toBeGreaterThanOrEqual(2);
    expect(screen.getByLabelText("Name")).toHaveValue("Ada Okafor");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("Record saved.")).not.toBeInTheDocument();
  });
});
