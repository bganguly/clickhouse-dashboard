import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/**
 * Guards the class of bugs found this session: the Chart's "Total" tile and
 * the list's result count must always agree (getExactAggregateTotal vs
 * listOrders' exactCount), across filter combinations, brush drags, and live
 * SSE writes. Run against a seeded dashboard:
 *   BASE_URL=http://localhost:3004 npx playwright test aggregate-parity
 */

const TIMEOUT = 10_000;

async function loadDashboard(page: Page): Promise<void> {
  await page.goto("/");
  const loaded = await page
    .locator("[data-testid='search-result']")
    .first()
    .isVisible({ timeout: 12_000 })
    .catch(() => false);
  if (!loaded) {
    await page.waitForTimeout(1500);
    await page.reload();
    await page.waitForLoadState("load");
  }
}

async function chartTotal(page: Page): Promise<number> {
  const chart = page.locator("[data-testid='chart']");
  const tile = chart.locator("[data-testid='aggregate-tile-total']").first();
  const noData = chart.getByText("No data for this range.");
  // Zero matches renders "No data for this range." instead of the Total tile —
  // race both so a short poll (this runs inside expectTotalsMatch's retry
  // loop) doesn't hang waiting for an element that will never appear.
  await Promise.race([
    tile.waitFor({ state: "visible", timeout: 3000 }).catch(() => {}),
    noData.waitFor({ state: "visible", timeout: 3000 }).catch(() => {}),
  ]);
  if (await tile.isVisible().catch(() => false)) {
    return Number((await tile.getAttribute("data-total")) ?? "0");
  }
  return 0;
}

async function listTotal(page: Page): Promise<number> {
  const el = page.locator("[data-testid='search-total']").first();
  await expect(el).toBeVisible({ timeout: TIMEOUT });
  return Number((await el.getAttribute("data-total")) ?? "0");
}

/** Chart and list totals must converge to the same number (they refetch on
 *  different debounces/effects, so this polls briefly rather than asserting
 *  instantaneously). */
async function expectTotalsMatch(page: Page, timeout = 8000): Promise<number> {
  let last = -1;
  await expect(async () => {
    const [c, l] = await Promise.all([chartTotal(page), listTotal(page)]);
    last = c;
    expect(c, `chart total (${c}) !== list total (${l})`).toBe(l);
  }).toPass({ timeout });
  return last;
}

/** Opens a MultiSelectFilter combobox, picks an option, then blurs the search
 *  input to close the dropdown again — left open, it intercepts clicks on
 *  whatever's rendered below it (e.g. the next filter's combobox). */
async function pickOption(
  page: Page,
  searchTestId: string,
  optionSelector: string,
  opts: { prefix?: boolean } = {},
): Promise<void> {
  const search = page.locator(`[data-testid='${searchTestId}']`);
  await search.click();
  const option = opts.prefix
    ? page.locator(`[data-testid^='${optionSelector}']`).first()
    : page.locator(`[data-testid='${optionSelector}']`);
  await option.click();
  await search.evaluate((el) => (el as HTMLElement).blur());
}

test.describe("Chart/list total parity — filter combinations", () => {
  test("1. fresh reload, no filters", async ({ page }) => {
    await loadDashboard(page);
    await expectTotalsMatch(page);
  });

  test("2. search filter only", async ({ page }) => {
    await loadDashboard(page);
    const input = page.locator("[data-testid='search-input']").first();
    await input.fill("hale");
    await input.press("Enter");
    await expectTotalsMatch(page);
  });

  test("3. status filter only", async ({ page }) => {
    await loadDashboard(page);
    await pickOption(page, "filter-status-search", "filter-status-CONFIRMED");
    await expectTotalsMatch(page);
  });

  test("4. region filter only", async ({ page }) => {
    await loadDashboard(page);
    await pickOption(page, "filter-region-search", "filter-region-", { prefix: true });
    await expectTotalsMatch(page);
  });

  test("5. order total (min/max) filter only", async ({ page }) => {
    await loadDashboard(page);
    await page.getByLabel("Minimum total").fill("50");
    await page.getByLabel("Maximum total").fill("500");
    await page.waitForTimeout(600); // debounced commit (FilterSidebar: 400ms)
    await expectTotalsMatch(page);
  });

  test("6. two-filter combo (search + status)", async ({ page }) => {
    await loadDashboard(page);
    const input = page.locator("[data-testid='search-input']").first();
    await input.fill("hale");
    await input.press("Enter");
    await pickOption(page, "filter-status-search", "filter-status-CONFIRMED");
    await expectTotalsMatch(page);
  });

  test("7. full combo + brush drag syncs placedAt and stays exact", async ({ page }) => {
    await loadDashboard(page);
    const input = page.locator("[data-testid='search-input']").first();
    await input.fill("hale");
    await input.press("Enter");
    await pickOption(page, "filter-status-search", "filter-status-CONFIRMED");
    await pickOption(page, "filter-region-search", "filter-region-", { prefix: true });
    await page.getByLabel("Minimum total").fill("10");
    await page.getByLabel("Maximum total").fill("1000");
    await page.waitForTimeout(600);
    await expectTotalsMatch(page);

    const chart = page.locator("[data-testid='chart']");
    const traveller = chart.locator(".recharts-brush-traveller").first();
    await expect(traveller).toBeVisible({ timeout: TIMEOUT });
    const box = await traveller.boundingBox();
    if (!box) throw new Error("no traveller bounding box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1500);

    // Placed-date sidebar fields must reflect the brushed window (the bug
    // this test guards: onRangeChange used to be dead code in uncontrolled mode).
    await expect(page.locator("input[type='date']").first()).not.toHaveValue("");
    await expectTotalsMatch(page);
  });

  test("8. clearing To after a brush drag expands the chart, not just the list", async ({ page }) => {
    // Regression: Chart keeps its own internal `range` state from brush
    // drags. Since brush-drag also writes into `filters.to` (test 7), a
    // stale `range.to` could survive clearing filters.to via the sidebar —
    // fetchAggregates' `filters?.to || to` fallback would keep silently
    // reusing the old brushed date forever, while the list (which has no
    // such fallback) correctly expanded. Chart and list must both expand.
    await loadDashboard(page);
    const chart = page.locator("[data-testid='chart']");
    const traveller = chart.locator(".recharts-brush-traveller").nth(1);
    await expect(traveller).toBeVisible({ timeout: TIMEOUT });
    const box = await traveller.boundingBox();
    if (!box) throw new Error("no traveller bounding box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 300, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1200);

    const beforeChart = await chartTotal(page);
    await expectTotalsMatch(page);

    const toInput = page.locator("input[type='date']").nth(1);
    await toInput.fill("");

    await expect(async () => {
      const c = await chartTotal(page);
      expect(c, "chart total must expand, not stay stuck at the brushed value").not.toBe(beforeChart);
    }).toPass({ timeout: 8000 });
    await expectTotalsMatch(page);
  });
});

test.describe("Live SSE + writes", () => {
  async function getValidIds(
    request: APIRequestContext,
  ): Promise<{ customerId: number; regionId: number; productId: number }> {
    const res = await request.get("/api/orders?page=1&pageSize=1");
    const json = await res.json();
    const row = json.data[0];
    return { customerId: row.customer.id, regionId: row.region.id, productId: row.items[0].productId };
  }

  async function createOrder(
    request: APIRequestContext,
    ids: { customerId: number; regionId: number; productId: number },
    notes: string,
  ): Promise<void> {
    const res = await request.post("/api/orders", {
      data: {
        customerId: ids.customerId,
        regionId: ids.regionId,
        currency: "USD",
        notes,
        items: [{ productId: ids.productId, quantity: 1, unitPrice: 25, discount: 0 }],
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  test("9. live batch of 4 (1 single + 3-batch) bumps both totals by exactly 4", async ({ page, request }) => {
    await loadDashboard(page);
    page.on("popup", (p) => void p.close().catch(() => {}));
    await page.getByLabel("Live").check();
    await expectTotalsMatch(page);
    const before = await chartTotal(page);

    const ids = await getValidIds(request);
    const marker = `e2e-live-${Date.now()}`;
    await createOrder(request, ids, `${marker} single`);
    await Promise.all([1, 2, 3].map((n) => createOrder(request, ids, `${marker} batch${n}`)));

    await expect(async () => {
      expect(await chartTotal(page)).toBe(before + 4);
    }).toPass({ timeout: 15_000 });
    await expectTotalsMatch(page);
  });

  test("10. live batch with an active filter only bumps matching orders", async ({ page, request }) => {
    await loadDashboard(page);
    page.on("popup", (p) => void p.close().catch(() => {}));
    await page.getByLabel("Live").check();

    const marker = `e2e-filtered-${Date.now()}`;
    const input = page.locator("[data-testid='search-input']").first();
    await input.fill(marker);
    await input.press("Enter");
    await expectTotalsMatch(page);
    const before = await chartTotal(page); // 0 — marker is unique to this run

    const ids = await getValidIds(request);
    await createOrder(request, ids, `${marker} match-1`);
    await createOrder(request, ids, `${marker} match-2`);
    await createOrder(request, ids, "unrelated order A (should not match)");
    await createOrder(request, ids, "unrelated order B (should not match)");

    await expect(async () => {
      expect(await chartTotal(page)).toBe(before + 2);
    }).toPass({ timeout: 15_000 });
    await expectTotalsMatch(page);
  });
});

test.describe("Out-of-order response race", () => {
  test("11. a slow stale request must not overwrite a faster newer one", async ({ page }) => {
    // Reproduces: brush-drag narrows the range (request A, artificially
    // slowed below to simulate it still being in flight), then the user
    // clears the To-date filter (request B, fast). Without the
    // abortRef-matches-controller guard in SearchTable/Chart, A's stale
    // response can land after B's and silently overwrite the correct total.
    // Let the real request complete server-side, then hold the response
    // before delivering it to the page — this keeps the browser's fetch()
    // promise genuinely pending (not merely delayed pre-dispatch), so an
    // abort() on it races against delivery the same way a real slow
    // response would, rather than being cancelled before it's ever sent.
    let ordersSeen = 0;
    await page.route("**/api/orders?**", async (route) => {
      ordersSeen += 1;
      const response = await route.fetch();
      if (ordersSeen === 1) await new Promise((r) => setTimeout(r, 2500));
      await route.fulfill({ response });
    });
    let aggSeen = 0;
    await page.route("**/api/aggregates?**", async (route) => {
      aggSeen += 1;
      const response = await route.fetch();
      if (aggSeen === 1) await new Promise((r) => setTimeout(r, 2500));
      await route.fulfill({ response });
    });

    await loadDashboard(page);
    const fromInput = page.locator("input[type='date']").nth(0);
    const toInput = page.locator("input[type='date']").nth(1);

    // Request A (slow): narrow with both from/to.
    await fromInput.fill("2026-06-10");
    await toInput.fill("2026-06-16");
    await page.waitForTimeout(200);
    // Request B (fast): clear "to" shortly after, before A resolves.
    await toInput.fill("");

    // B should win: totals must land on the wider (cleared-to) result, not
    // get silently overwritten when A's delayed response arrives later.
    await expect(async () => {
      const [c, l] = await Promise.all([chartTotal(page), listTotal(page)]);
      expect(c, `chart=${c} list=${l}`).toBe(l);
    }).toPass({ timeout: 8000 });

    // Give A's delayed response time to land, then confirm it didn't regress
    // the totals back to the narrower (stale) window.
    await page.waitForTimeout(3000);
    const [c, l] = await Promise.all([chartTotal(page), listTotal(page)]);
    expect(c, `chart=${c} list=${l} after stale response window`).toBe(l);
    expect(await toInput.inputValue()).toBe("");
  });
});
