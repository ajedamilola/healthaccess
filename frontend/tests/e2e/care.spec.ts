import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { areas, facilities, facilityDetails, services } from "../../src/api/mocks/fixtures/directory";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockDirectory(page: Page, options: { emptyBelowRadius?: number } = {}) {
  await page.route(/\/api\/v1\/directory\/services$/, (route) => json(route, services));

  await page.route(/\/api\/v1\/directory\/areas(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const query = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase();
    const limit = Number(url.searchParams.get("limit") ?? 5);
    const matches = areas
      .filter(
        (area) =>
          !query ||
          area.name.toLocaleLowerCase().includes(query) ||
          (area.city ?? "").toLocaleLowerCase().includes(query) ||
          (area.region ?? "").toLocaleLowerCase().includes(query),
      )
      .slice(0, limit);
    return json(route, matches);
  });

  await page.route(/\/api\/v1\/directory\/facilities(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const service = url.searchParams.get("service");
    const radius = Number(url.searchParams.get("radius_km") ?? 25);
    const limit = Number(url.searchParams.get("limit") ?? 3);
    if (options.emptyBelowRadius !== undefined && radius < options.emptyBelowRadius) {
      return json(route, []);
    }
    const matches = facilities
      .filter((facility) => facility.service_code === service && facility.distance_km <= radius)
      .sort((left, right) => left.distance_km - right.distance_km || left.name.localeCompare(right.name))
      .slice(0, limit);
    return json(route, matches);
  });

  await page.route(/\/api\/v1\/directory\/facilities\/[^/?]+$/, (route) => {
    const id = route.request().url().split("/").pop() ?? "";
    const detail = facilityDetails[id as keyof typeof facilityDetails];
    return detail
      ? json(route, detail)
      : json(route, { error: "not_found", request_id: "req-e2e-not-found" }, 404);
  });
}

function seriousViolations(violations: Array<{ impact?: string | null }>) {
  return violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
}

async function searchGeneralCare(page: Page) {
  await page.getByRole("combobox", { name: "Service" }).click();
  await page.getByRole("option", { name: "General care" }).click();
  await page.getByRole("combobox", { name: "Area" }).click();
  await page.getByRole("combobox", { name: "Area" }).fill("Ikeja");
  await expect(page.getByRole("option", { name: /^Ikeja demo area/ })).toBeVisible();
  await page.getByRole("option", { name: /^Ikeja demo area/ }).click();
  await page.getByRole("button", { name: "Search facilities" }).click();
}

test.describe("care directory journey", () => {
  for (const width of [390, 1440]) {
    test(`find care, result and detail pass at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockDirectory(page);

      await page.goto("/find-care");
      await expect(page.getByRole("heading", { name: "Find care", level: 1 })).toBeVisible();

      await searchGeneralCare(page);

      await expect(page.getByRole("heading", { name: "Demo Community Hospital", level: 3 })).toBeVisible();
      await expect(page.getByText("≈ 0.4 km from the area centre (straight line)")).toBeVisible();
      await expect(page.getByText("Nearby Children's Clinic")).toHaveCount(0);
      await expect(page.getByText("Demo data").first()).toBeVisible();
      await expect(page.getByRole("heading", { level: 3 })).toHaveCount(3);

      const resultsScan = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      expect(
        seriousViolations(resultsScan.violations),
        JSON.stringify(seriousViolations(resultsScan.violations), null, 2),
      ).toEqual([]);

      await page.screenshot({ path: `test-results/lane-c/find-care-${width}.png`, fullPage: true });

      await page.getByRole("link", { name: "View details for Demo Community Hospital" }).click();
      await expect(page).toHaveURL(/\/facilities\/20000000-0000-4000-8000-000000000002$/);
      await expect(page.getByRole("heading", { name: "Demo Community Hospital", level: 1 })).toBeVisible();
      await expect(page.locator("address")).toHaveText("12 Example Road, Ikeja");
      await expect(page.getByText("Ikeja demo area, Lagos", { exact: true })).toBeVisible();
      await expect(page.getByText("Directory details last verified 17 November 2026")).toBeVisible();
      await expect(page.getByText("Source trust: unknown")).toBeVisible();
      await expect(
        page.getByRole("region", { name: "Directory details" }).getByText(
          "A recommendation does not book a visit or confirm availability.",
        ),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: /call/i })).toHaveCount(0);

      const detailScan = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      expect(
        seriousViolations(detailScan.violations),
        JSON.stringify(seriousViolations(detailScan.violations), null, 2),
      ).toEqual([]);

      await page.screenshot({ path: `test-results/lane-c/facility-${width}.png`, fullPage: true });
    });
  }

  test("the empty result widens the radius and never changes the URL", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await mockDirectory(page, { emptyBelowRadius: 50 });

    await page.goto("/find-care");
    await searchGeneralCare(page);

    await expect(
      page.getByText(
        "No listed facility offers this service within 25 km. Try a wider radius or another area.",
      ),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/find-care$/);
    await expect(page.getByRole("heading", { level: 3 })).toHaveCount(1);

    const emptyScan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      seriousViolations(emptyScan.violations),
      JSON.stringify(seriousViolations(emptyScan.violations), null, 2),
    ).toEqual([]);

    await page.getByRole("button", { name: "Search within 50 km" }).click();

    await expect(page.getByRole("heading", { name: "Demo Community Hospital", level: 3 })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3 })).toHaveCount(3);
    await expect(page).toHaveURL(/\/find-care$/);
  });
});
