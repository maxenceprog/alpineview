import { test, expect } from "@playwright/test";

// Three.js WebGL errors and tile/draco fetch failures are expected in headless.
const IGNORED = [
  /WebGL/i,
  /Failed to load resource/i,
  /tiles\/index\.json/i,
  /draco/i,
];

function isIgnored(msg) {
  return IGNORED.some((re) => re.test(msg));
}

test.beforeEach(async ({ page }) => {
  page._errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !isIgnored(msg.text())) {
      page._errors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    if (!isIgnored(err.message)) page._errors.push(err.message);
  });

  // Stub tile index so the app doesn't 404 in headless
  await page.route("/tiles/index.json", (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ tiles: [] }) })
  );

  await page.goto("/");
  await page.waitForSelector("#status");
});

function assertNoErrors(page) {
  expect(page._errors, `Console errors: ${page._errors.join("\n")}`).toHaveLength(0);
}

test("page loads without JS errors", async ({ page }) => {
  assertNoErrors(page);
});

test("search bar is present", async ({ page }) => {
  expect(await page.locator("#search-input").count()).toBe(1);
  expect(await page.locator("#search-btn").count()).toBe(1);
});

test("search with stubbed Nominatim does not throw", async ({ page }) => {
  await page.route("**/nominatim.openstreetmap.org/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { lat: "44.924", lon: "6.358", display_name: "Barre des Écrins, Hautes-Alpes" },
      ]),
    })
  );

  await page.fill("#search-input", "Barre des Écrins");
  await page.click("#search-btn");
  await page.waitForTimeout(300);
  assertNoErrors(page);
});

test("search with empty Nominatim result does not throw", async ({ page }) => {
  await page.route("**/nominatim.openstreetmap.org/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  );

  await page.fill("#search-input", "xyznotaplace");
  await page.click("#search-btn");
  await page.waitForTimeout(200);
  assertNoErrors(page);
});

test("layer buttons toggle without throwing", async ({ page }) => {
  for (const layer of ["satellite", "terrain"]) {
    await page.click(`.layer-btn[data-layer="${layer}"]`);
    await page.waitForTimeout(50);
  }
  assertNoErrors(page);
});

test("sun date change does not throw", async ({ page }) => {
  await page.fill("#sun-date", "2025-07-14T14:00");
  await page.dispatchEvent("#sun-date", "change");
  await page.waitForTimeout(100);
  assertNoErrors(page);
});

test("sidebar toggle does not throw", async ({ page }) => {
  await page.click("#toggle-left");
  await page.click("#toggle-left");
  await page.waitForTimeout(100);
  assertNoErrors(page);
});

test("C key does not switch camera mode when search bar is focused", async ({ page }) => {
  const initialMode = await page.locator("#camera-mode").textContent();

  await page.focus("#search-input");
  await page.press("#search-input", "KeyC");
  await page.waitForTimeout(100);

  const modeAfter = await page.locator("#camera-mode").textContent();
  expect(modeAfter).toBe(initialMode);
  assertNoErrors(page);
});

test("C key switches camera mode when canvas has focus", async ({ page }) => {
  const initialMode = await page.locator("#camera-mode").textContent();

  await page.evaluate(() => document.querySelector("canvas").focus());
  await page.press("body", "KeyC");
  await page.waitForTimeout(100);

  const modeAfter = await page.locator("#camera-mode").textContent();
  expect(modeAfter).not.toBe(initialMode);
  assertNoErrors(page);
});
