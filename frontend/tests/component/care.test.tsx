import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import { server } from "@/api/mocks/server";
import { areas, facilities, facilityDetails, services } from "@/api/mocks/fixtures";
import { directoryHandlers } from "@/api/mocks/handlers/directory";
import { FindCare } from "@/features/care/FindCare";
import { FacilityCard } from "@/features/care/FacilityCard";
import { FacilityDetailView } from "@/features/care/FacilityDetail";
import { renderWithProviders } from "./utils";

// Multi-step user flows exceed the 5 s default when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 20_000 });

const HOSPITAL_ID = "20000000-0000-4000-8000-000000000002";
const FAMILY_CENTRE_ID = "20000000-0000-4000-8000-000000000004";
const MISSING_ID = "20000000-0000-4000-8000-000000000099";

// Radix Select uses pointer capture, which jsdom does not implement.
Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => false });
Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: () => {} });
Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: () => {} });

function matchingFacilities(url: URL) {
  const service = url.searchParams.get("service");
  const radius = Number(url.searchParams.get("radius_km") ?? 25);
  const limit = Number(url.searchParams.get("limit") ?? 3);
  return facilities
    .filter((facility) => facility.service_code === service && facility.distance_km <= radius)
    .sort((left, right) => left.distance_km - right.distance_km || left.name.localeCompare(right.name))
    .slice(0, limit);
}

async function selectService(user: ReturnType<typeof userEvent.setup>, label = "General care") {
  const trigger = screen.getByLabelText("Service");
  await waitFor(() => expect(trigger).not.toBeDisabled());
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: label }));
}

async function selectArea(user: ReturnType<typeof userEvent.setup>, query = "Ikeja") {
  const input = screen.getByLabelText("Area");
  await user.click(input);
  await user.type(input, query);
  await user.click(await screen.findByRole("option", { name: /^Ikeja demo area/ }));
}

async function search(user: ReturnType<typeof userEvent.setup>, service = "General care") {
  await selectService(user, service);
  await selectArea(user);
  await user.click(screen.getByRole("button", { name: "Search facilities" }));
}

beforeEach(() => {
  server.use(...directoryHandlers);
});

describe("FindCare", () => {
  it("shows a skeleton matching the results, then renders the server list", async () => {
    const user = userEvent.setup({ delay: null });
    server.use(
      http.get("/api/v1/directory/facilities", async ({ request }) => {
        await delay(500);
        return HttpResponse.json(matchingFacilities(new URL(request.url)));
      }),
    );

    renderWithProviders(<FindCare />);
    await search(user);

    expect(
      await screen.findAllByRole("status", { name: /loading facility result/i }, { timeout: 3000 }),
    ).toHaveLength(3);

    expect(await screen.findByRole("heading", { name: "Demo Community Hospital", level: 3 })).toBeInTheDocument();
    expect(screen.getByText("12 Example Road, Ikeja")).toBeInTheDocument();
    expect(screen.getByText("≈ 0.4 km from the area centre (straight line)")).toBeInTheDocument();
    expect(screen.getAllByText("Demo data")).toHaveLength(3);
    expect(screen.queryByText("Nearby Children's Clinic")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View details for Demo Community Hospital" })).toHaveAttribute(
      "href",
      "/facilities/20000000-0000-4000-8000-000000000002",
    );
  });

  it("renders exactly the current server list and never merges a previous search", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<FindCare />);

    await search(user);
    expect(await screen.findByRole("heading", { name: "Demo Community Hospital", level: 3 })).toBeInTheDocument();

    await selectService(user, "Child health");
    await user.click(screen.getByRole("button", { name: "Search facilities" }));

    expect(await screen.findByRole("heading", { name: "Nearby Children's Clinic", level: 3 })).toBeInTheDocument();
    expect(screen.queryByText("Demo Community Hospital")).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(1);
  });

  it("shows the empty state and widens the radius from 25 to 50 km", async () => {
    const user = userEvent.setup({ delay: null });
    const radii: number[] = [];
    server.use(
      http.get("/api/v1/directory/facilities", ({ request }) => {
        const url = new URL(request.url);
        const radius = Number(url.searchParams.get("radius_km"));
        radii.push(radius);
        return HttpResponse.json(radius < 50 ? [] : matchingFacilities(url));
      }),
    );

    renderWithProviders(<FindCare />);
    await search(user);

    expect(
      await screen.findByText(
        "No listed facility offers this service within 25 km. Try a wider radius or another area.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Search within 50 km" }));

    expect(await screen.findByRole("heading", { name: "Demo Community Hospital", level: 3 })).toBeInTheDocument();
    expect(radii).toEqual([25, 50]);
  });

  it("offers a change-area action when the radius is already the widest", async () => {
    const user = userEvent.setup({ delay: null });
    server.use(http.get("/api/v1/directory/facilities", () => HttpResponse.json([])));

    renderWithProviders(<FindCare />);
    await search(user);

    expect(
      await screen.findByText(
        "No listed facility offers this service within 25 km. Try a wider radius or another area.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Search within 50 km" }));

    expect(
      await screen.findByText(
        "No listed facility offers this service within 50 km. Try a wider radius or another area.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Change area" }));

    expect(screen.getByLabelText("Area")).toHaveFocus();
  });

  it("shows a retry with the request id when the area search fails", async () => {
    const user = userEvent.setup({ delay: null });
    let attempt = 0;
    server.use(
      http.get("/api/v1/directory/areas", () => {
        attempt += 1;
        return attempt === 1
          ? HttpResponse.json({ error: "upstream_unavailable", request_id: "req-areas-1" }, { status: 500 })
          : HttpResponse.json(areas);
      }),
    );

    renderWithProviders(<FindCare />);
    const input = screen.getByLabelText("Area");
    await user.click(input);

    expect(await screen.findByText("Could not search areas")).toBeInTheDocument();
    expect(screen.getByText("Request ID: req-areas-1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry area search" }));
    await user.click(input);

    expect(await screen.findByRole("option", { name: /^Ikeja demo area/ })).toBeInTheDocument();
    expect(attempt).toBe(2);
  });

  it("shows an offline banner and keeps typed entries", async () => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });

    try {
      const user = userEvent.setup({ delay: null });
      renderWithProviders(<FindCare />);

      expect(await screen.findByText("You are offline")).toBeInTheDocument();

      await user.type(screen.getByLabelText("Area"), "Ike");
      expect(screen.getByLabelText("Area")).toHaveValue("Ike");
    } finally {
      if (original) Object.defineProperty(window.navigator, "onLine", original);
      else Reflect.deleteProperty(window.navigator, "onLine");
    }
  });

  it("raises the result limit from 3 to 10 with Show more", async () => {
    const user = userEvent.setup({ delay: null });
    const limits: number[] = [];
    server.use(
      http.get("/api/v1/directory/facilities", ({ request }) => {
        const url = new URL(request.url);
        limits.push(Number(url.searchParams.get("limit")));
        return HttpResponse.json(matchingFacilities(url));
      }),
    );

    renderWithProviders(<FindCare />);
    await search(user);

    await screen.findByRole("heading", { name: "Demo Community Hospital", level: 3 });
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(3);
    expect(screen.queryByText("Demo Community Clinic")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show more" }));

    expect(await screen.findByRole("heading", { name: "Demo Community Clinic", level: 3 })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    expect(limits).toEqual([3, 10]);
  });

  it("validates a missing service and area without calling the facilities endpoint", async () => {
    const user = userEvent.setup({ delay: null });
    let calls = 0;
    server.use(
      http.get("/api/v1/directory/facilities", () => {
        calls += 1;
        return HttpResponse.json([]);
      }),
    );

    renderWithProviders(<FindCare />);
    await waitFor(() => expect(screen.getByLabelText("Service")).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Search facilities" }));

    expect(await screen.findByText("Choose a service.")).toBeInTheDocument();
    expect(screen.getByText("Choose an area.")).toBeInTheDocument();
    expect(calls).toBe(0);
    expect(screen.getByLabelText("Service")).toHaveFocus();
  });

  it("shows a retry with the request id when facilities fail", async () => {
    const user = userEvent.setup({ delay: null });
    let attempt = 0;
    server.use(
      http.get("/api/v1/directory/facilities", ({ request }) => {
        attempt += 1;
        if (attempt === 1) {
          return HttpResponse.json(
            { error: "upstream_unavailable", message: "Directory is down", request_id: "req-care-1" },
            { status: 500 },
          );
        }
        return HttpResponse.json(matchingFacilities(new URL(request.url)));
      }),
    );

    renderWithProviders(<FindCare />);
    await search(user);

    expect(await screen.findByText("Could not load facilities")).toBeInTheDocument();
    expect(screen.getByText("Request ID: req-care-1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Demo Community Hospital", level: 3 })).toBeInTheDocument();
    expect(attempt).toBe(2);
  });

  it("shows the denied state without a retry button", async () => {
    const user = userEvent.setup({ delay: null });
    server.use(
      http.get("/api/v1/directory/facilities", () =>
        HttpResponse.json({ error: "forbidden", request_id: "req-care-denied" }, { status: 403 }),
      ),
    );

    renderWithProviders(<FindCare />);
    await search(user);

    expect(
      await screen.findByText(
        "You do not have access to this directory. Contact support if this keeps happening.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("shows a retry with the request id when services fail to load", async () => {
    const user = userEvent.setup({ delay: null });
    let attempt = 0;
    server.use(
      http.get("/api/v1/directory/services", () => {
        attempt += 1;
        return attempt === 1
          ? HttpResponse.json({ error: "upstream_unavailable", request_id: "req-services-1" }, { status: 500 })
          : HttpResponse.json(services);
      }),
    );

    renderWithProviders(<FindCare />);

    expect(await screen.findByText("Could not load services")).toBeInTheDocument();
    expect(screen.getByText("Request ID: req-services-1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.getByLabelText("Service")).not.toBeDisabled());
    expect(screen.queryByText("Could not load services")).not.toBeInTheDocument();
  });

  it("shows an empty services state with a way to check again", async () => {
    const user = userEvent.setup({ delay: null });
    let attempt = 0;
    server.use(
      http.get("/api/v1/directory/services", () => {
        attempt += 1;
        return attempt === 1 ? HttpResponse.json([]) : HttpResponse.json(services);
      }),
    );

    renderWithProviders(<FindCare />);

    expect(await screen.findByText("No services are listed")).toBeInTheDocument();
    expect(screen.getByLabelText("Service")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Search facilities" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(screen.getByLabelText("Service")).not.toBeDisabled());
    await waitFor(() => expect(screen.queryByText("No services are listed")).not.toBeInTheDocument());
    expect(attempt).toBe(2);
  });

  it("debounces the area search by 250 ms", async () => {
    const user = userEvent.setup({ delay: null });
    const areaRequests: URL[] = [];
    server.use(
      http.get("/api/v1/directory/areas", ({ request }) => {
        const url = new URL(request.url);
        areaRequests.push(url);
        const query = (url.searchParams.get("q") ?? "").toLocaleLowerCase();
        return HttpResponse.json(
          query
            ? [
                {
                  id: "20000000-0000-4000-8000-000000000001",
                  name: "Ikeja demo area",
                  region: "Lagos",
                  city: "Ikeja",
                  is_demo: true,
                },
              ]
            : [],
        );
      }),
    );

    renderWithProviders(<FindCare />);
    const input = screen.getByLabelText("Area");
    await user.click(input);
    await waitFor(() => expect(areaRequests).toHaveLength(1));

    areaRequests.length = 0;
    await user.type(input, "Ikeja");

    await waitFor(() => expect(areaRequests.some((url) => url.searchParams.get("q") === "Ikeja")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(areaRequests.filter((url) => url.searchParams.get("q") === "Ikeja")).toHaveLength(1);
    expect(areaRequests.filter((url) => url.searchParams.get("q"))).toHaveLength(1);
  });
});

const [hospital, , familyCentre] = facilities;

describe("FacilityCard", () => {
  it("shows name, address, straight-line distance and the demo badge, with no phone link when phone is null", () => {
    render(<FacilityCard facility={hospital} />);

    expect(screen.getByRole("heading", { name: "Demo Community Hospital" })).toBeInTheDocument();
    expect(screen.getByText("12 Example Road, Ikeja")).toBeInTheDocument();
    expect(screen.getByText("≈ 0.4 km from the area centre (straight line)")).toBeInTheDocument();
    expect(screen.getByText("Demo data")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /call/i })).not.toBeInTheDocument();
  });

  it("links a listed phone number with tel:", () => {
    render(<FacilityCard facility={familyCentre} />);

    expect(
      screen.getByRole("link", { name: "Call Demo Family Health Centre on +2348012345678" }),
    ).toHaveAttribute("href", "tel:+2348012345678");
  });

  it("hides the demo badge for real directory data", () => {
    render(<FacilityCard facility={{ ...hospital, is_demo: false }} />);

    expect(screen.queryByText("Demo data")).not.toBeInTheDocument();
  });
});

describe("FacilityDetailView", () => {
  it("shows a skeleton, then the address, area, services and directory details", async () => {
    server.use(
      http.get("/api/v1/directory/facilities/:id", async ({ params }) => {
        await delay(80);
        const detail = facilityDetails[String(params.id) as keyof typeof facilityDetails];
        return detail ? HttpResponse.json(detail) : HttpResponse.json({ error: "not_found" }, { status: 404 });
      }),
    );

    renderWithProviders(<FacilityDetailView id={HOSPITAL_ID} />);

    expect(screen.getByRole("heading", { name: "Facility details", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading facility details" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Demo Community Hospital", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Facility details", level: 1 })).not.toBeInTheDocument();

    expect(screen.getByText("12 Example Road, Ikeja")).toBeInTheDocument();
    expect(screen.getByText("Ikeja demo area, Lagos")).toBeInTheDocument();
    expect(screen.getByText("General care")).toBeInTheDocument();
    expect(screen.getByText("Child health")).toBeInTheDocument();
    expect(screen.getByText("Directory details last verified 17 November 2026")).toBeInTheDocument();
    expect(screen.getByText("Demo data")).toBeInTheDocument();
    expect(screen.getByText("Source trust: unknown")).toBeInTheDocument();
    expect(
      screen.getByText("A recommendation does not book a visit or confirm availability."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /call/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to find care" })).toHaveAttribute("href", "/find-care");
  });

  it("links a listed phone number with tel: and shows a verified trust badge", async () => {
    renderWithProviders(<FacilityDetailView id={FAMILY_CENTRE_ID} />);

    expect(await screen.findByRole("heading", { name: "Demo Family Health Centre", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Call +2348012345678" })).toHaveAttribute(
      "href",
      "tel:+2348012345678",
    );
    expect(screen.getByText("Source trust: verified")).toBeInTheDocument();
  });

  it("shows the generic not-found message without a retry", async () => {
    renderWithProviders(<FacilityDetailView id={MISSING_ID} />);

    expect(await screen.findByText("This item is not available.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Facility details", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to find care" })).toBeInTheDocument();
  });

  it("explains when no phone or services are listed", async () => {
    server.use(
      http.get("/api/v1/directory/facilities/:id", () =>
        HttpResponse.json({ ...facilityDetails[HOSPITAL_ID], phone: null, services: [] }),
      ),
    );

    renderWithProviders(<FacilityDetailView id={HOSPITAL_ID} />);

    expect(await screen.findByRole("heading", { name: "Demo Community Hospital", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("No phone number is listed.")).toBeInTheDocument();
    expect(screen.getByText("No services are listed.")).toBeInTheDocument();
  });

  it("retries a failed load and shows the request id for support", async () => {
    const user = userEvent.setup({ delay: null });
    let attempt = 0;
    server.use(
      http.get("/api/v1/directory/facilities/:id", ({ params }) => {
        attempt += 1;
        if (attempt === 1) {
          return HttpResponse.json(
            { error: "upstream_unavailable", request_id: "req-facility-1" },
            { status: 500 },
          );
        }
        const detail = facilityDetails[String(params.id) as keyof typeof facilityDetails];
        return detail ? HttpResponse.json(detail) : HttpResponse.json({ error: "not_found" }, { status: 404 });
      }),
    );

    renderWithProviders(<FacilityDetailView id={HOSPITAL_ID} />);

    expect(await screen.findByText("Could not load this facility")).toBeInTheDocument();
    expect(screen.getByText("Request ID: req-facility-1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Demo Community Hospital", level: 1 })).toBeInTheDocument();
    expect(attempt).toBe(2);
  });

  it("shows the denied state without a retry", async () => {
    server.use(
      http.get("/api/v1/directory/facilities/:id", () =>
        HttpResponse.json({ error: "forbidden", request_id: "req-facility-denied" }, { status: 403 }),
      ),
    );

    renderWithProviders(<FacilityDetailView id={HOSPITAL_ID} />);

    expect(
      await screen.findByText(
        "You do not have access to this facility. Contact support if this keeps happening.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});
