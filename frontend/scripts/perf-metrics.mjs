#!/usr/bin/env node
/**
 * Chromium mobile lab metrics fallback when Lighthouse cannot launch in this environment.
 * Measures LCP and CLS at 390x844 on /app (signed in) and /find-care.
 * No writes and no AI calls.
 */
import { chromium, devices } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const base = (process.env.PERF_BASE_URL ?? "http://127.0.0.1:3210").replace(/\/+$/, "");
const outDir = path.resolve("test-results/lighthouse");

async function collect(page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        let lcp = 0;
        let cls = 0;
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) lcp = entry.startTime;
          }).observe({ type: "largest-contentful-paint", buffered: true });
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (!entry.hadRecentInput) cls += entry.value;
            }
          }).observe({ type: "layout-shift", buffered: true });
        } catch {
          // Older engines may not expose an observer; the defaults stay 0.
        }
        setTimeout(() => resolve({ lcp, cls }), 800);
      }),
  );
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();

  const mobile = { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } };

  const appContext = await browser.newContext(mobile);
  const appPage = await appContext.newPage();
  await appPage.goto(`${base}/login`);
  await appPage.getByLabel("Email").fill("demo.patient@example.test");
  await appPage.getByLabel("Password", { exact: true }).fill("DemoPass123!");
  await appPage.getByRole("button", { name: "Sign in" }).click();
  await appPage.waitForURL(/\/app$/);
  await appPage.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  const app = await collect(appPage);
  await appContext.close();

  const careContext = await browser.newContext(mobile);
  const carePage = await careContext.newPage();
  await carePage.goto(`${base}/find-care`);
  await carePage.getByRole("heading", { name: "Find care", level: 1 }).waitFor().catch(() => {});
  const care = await collect(carePage);
  await careContext.close();

  await browser.close();

  const results = {
    viewport: "390x844 mobile",
    app: { lcpMs: Math.round(app.lcp), cls: Number(app.cls.toFixed(3)) },
    findCare: { lcpMs: Math.round(care.lcp), cls: Number(care.cls.toFixed(3)) },
  };
  await writeFile(path.join(outDir, "playwright-metrics.json"), JSON.stringify(results, null, 2));
  console.log(`/app: LCP ${results.app.lcpMs} ms, CLS ${results.app.cls}`);
  console.log(`/find-care: LCP ${results.findCare.lcpMs} ms, CLS ${results.findCare.cls}`);
}

main().catch((error) => {
  console.error(`perf metrics failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
