import { chromium, expect } from "@playwright/test";

// Run against a local web dev server, for example:
// PUBLIC_WEB_URL=http://127.0.0.1:15173 bun scripts/public-browser-smoke.ts
const url = new URL(process.env.PUBLIC_WEB_URL ?? "http://127.0.0.1:15173");
if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("Public browser smoke test requires a local server");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
const requests: string[] = [];
page.on("pageerror", error => errors.push(error.message));
page.on("request", request => {
  const target = new URL(request.url());
  if (target.pathname.startsWith("/api/")) requests.push(target.pathname);
});
try {
  await page.route("**/api/public/analytics**", route => route.fulfill({
    status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found" }),
  }));
  await page.goto(new URL("/public", url).toString());
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.getByText("Live public analytics are disabled")).toBeVisible();
  await expect(page.getByText("A limited selection of my actual usage.")).toBeVisible();
  await page.getByRole("link", { name: "Explore the fuller dashboard with synthetic data" }).click();
  await expect(page.getByRole("region", { name: "Synthetic sample workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Cache reads", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Usage over time" })).toBeVisible();
  await page.getByLabel("Machine", { exact: true }).selectOption("machine-studio");
  await page.getByRole("button", { name: "Request attempts", exact: true }).click();
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Request attempts", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByLabel("Machine", { exact: true })).toHaveValue("machine-studio");
  await page.getByRole("button", { name: "Tool executions", exact: true }).click();
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await page.getByRole("button", { name: "Reset sample filters" }).click();
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await expect(page.locator("tbody tr").first()).toBeVisible();
  const requestsBefore = requests.length;
  await page.getByRole("button", { name: "Accounts & keys", exact: true }).click();
  await page.getByRole("button", { name: "Machines", exact: true }).click();
  await expect(page.locator("tbody tr").first()).toBeVisible();
  if (requests.length !== requestsBefore) throw new Error("Synthetic sample issued an API request");
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Public sample overflows on mobile");
  if (requests.some(path => path !== "/api/public/analytics")) throw new Error("Public page requested a private API");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Public browser smoke passed: disabled state, isolated synthetic views and mobile layout.");
} finally {
  await browser.close();
}
