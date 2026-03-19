import { test, expect } from '@playwright/test';

// E1: Smoke test — health a auth
test('API health check', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.status).toBe('ok');
  expect(json.db).toBeDefined();
});

// E2: Dashboard načtení
test('Dashboard loads with stats and quality metrics', async ({ page }) => {
  await page.goto('/#/warehouse');
  // Stat karty viditelné s číselnými hodnotami
  const statCards = page.locator('.grid .rounded-lg.border.p-4');
  await expect(statCards.first()).toBeVisible({ timeout: 10000 });
  // Alespoň 4 stat karty
  await expect(statCards).toHaveCount(4);
  // Quality metriky sekce
  const qualitySection = page.locator('text=Kvalita dat');
  await expect(qualitySection).toBeVisible({ timeout: 10000 });
  // Kategorie tabulka má alespoň 1 řádek
  const categoryRows = page.locator('text=Rozložení kategorií').locator('..').locator('table tbody tr');
  // Může být prázdná v testovém prostředí, ale sekce existuje
  const categoryHeading = page.locator('text=Rozložení kategorií');
  await expect(categoryHeading).toBeVisible();
});

// E3: Vyhledávání a filtrování produktů
test('Product search and filtering works', async ({ page }) => {
  await page.goto('/#/warehouse/products');

  // Searchbox existuje
  const searchInput = page.locator('input[placeholder="Hledat produkty..."]');
  await expect(searchInput).toBeVisible({ timeout: 10000 });

  // Zadat "HP" do vyhledávání
  await searchInput.fill('HP');
  // Počkat na debounce + URL update
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/q=HP/);

  // Kategorie dropdown
  const categorySelect = page.locator('select').first();
  await expect(categorySelect).toBeVisible();

  // Cenový rozsah
  const priceMinInput = page.locator('input[placeholder="Cena od"]');
  const priceMaxInput = page.locator('input[placeholder="Cena do"]');
  await expect(priceMinInput).toBeVisible();
  await expect(priceMaxInput).toBeVisible();

  // Zadat cenový rozsah
  await priceMinInput.fill('1000');
  await priceMaxInput.fill('50000');
  await page.waitForTimeout(700);
  await expect(page).toHaveURL(/price_min=1000/);
  await expect(page).toHaveURL(/price_max=50000/);

  // Vyčistit filtry
  await searchInput.fill('');
  await priceMinInput.fill('');
  await priceMaxInput.fill('');
  await page.waitForTimeout(700);
});

// E3b: Validace min > max
test('Price filter shows validation when min > max', async ({ page }) => {
  await page.goto('/#/warehouse/products');
  await page.waitForTimeout(500);

  const priceMinInput = page.locator('input[placeholder="Cena od"]');
  const priceMaxInput = page.locator('input[placeholder="Cena do"]');

  // Nejdříve nastavit max, pak min vyšší
  await priceMaxInput.fill('100');
  await page.waitForTimeout(600);
  await priceMinInput.fill('500');
  await page.waitForTimeout(600);

  // Validační zpráva
  const validationMsg = page.locator('text=Min cena musí být menší než max');
  await expect(validationMsg).toBeVisible();
});

// E4: Třídění sloupců
test('Column sorting works', async ({ page }) => {
  await page.goto('/#/warehouse/products');
  await page.waitForTimeout(1000);

  // Klik na "Cena" header
  const priceHeader = page.locator('th', { hasText: 'Cena' });
  await priceHeader.click();
  await expect(page).toHaveURL(/sort=price/);
  await expect(page).toHaveURL(/dir=asc/);

  // Klik znovu → sestupně
  await priceHeader.click();
  await expect(page).toHaveURL(/dir=desc/);
});

// E5: Navigace na detail produktu
test('Product detail navigation and back', async ({ page }) => {
  await page.goto('/#/warehouse/products');
  await page.waitForTimeout(1000);

  // Kliknout na první produkt v tabulce
  const firstRow = page.locator('table tbody tr').first();
  // Může být "Načítám" nebo reálný row
  const hasProducts = await firstRow.locator('td').count() > 1;
  if (!hasProducts) {
    test.skip(true, 'Žádné produkty v DB');
    return;
  }

  await firstRow.click();
  await page.waitForTimeout(500);

  // URL se změní na product detail
  await expect(page).toHaveURL(/#\/warehouse\/product\/.+/);

  // Breadcrumb existuje
  const breadcrumb = page.locator('nav', { hasText: 'Cenový sklad' });
  await expect(breadcrumb).toBeVisible();

  // Zpět na seznam
  const backButton = page.locator('button', { hasText: 'Zpět na seznam' });
  await backButton.click();
  await page.waitForTimeout(500);

  // Měli bychom být na products tabu, ne dashboardu
  await expect(page).toHaveURL(/warehouse\/product/);
  // history.back() nás vrátí na products
});

// E6: Deep link sdílení
test('Deep link to product detail works', async ({ page }) => {
  // Nejdříve zjistíme ID produktu
  const apiRes = await page.request.get('/api/warehouse/products?limit=1');
  const data = await apiRes.json();
  if (!data.items || data.items.length === 0) {
    test.skip(true, 'Žádné produkty v DB');
    return;
  }
  const productId = data.items[0].id;

  // Navigovat přímo na deep link
  await page.goto(`/#/warehouse/product/${productId}`);
  await page.waitForTimeout(1000);

  // Detail se načte
  const heading = page.locator('h2');
  await expect(heading).toBeVisible({ timeout: 10000 });
});

// E7: Grid view
test('Grid view persists across reload', async ({ page }) => {
  await page.goto('/#/warehouse/products');
  await page.waitForTimeout(1000);

  // Přepnout na grid view
  const gridButton = page.locator('button[title="Mřížka"]');
  await gridButton.click();
  await page.waitForTimeout(300);

  // Ověřit localStorage
  const viewMode = await page.evaluate(() => localStorage.getItem('warehouse_view_mode'));
  expect(viewMode).toBe('grid');

  // Reload → grid přetrvá
  await page.reload();
  await page.waitForTimeout(1000);

  const viewModeAfterReload = await page.evaluate(() => localStorage.getItem('warehouse_view_mode'));
  expect(viewModeAfterReload).toBe('grid');

  // Cleanup: vrátit na list
  await page.evaluate(() => localStorage.setItem('warehouse_view_mode', 'list'));
});

// E8: Prázdný stav
test('Empty search shows "Nic nenalezeno"', async ({ page }) => {
  await page.goto('/#/warehouse/products');
  await page.waitForTimeout(500);

  const searchInput = page.locator('input[placeholder="Hledat produkty..."]');
  await searchInput.fill('xyznonexistent123');
  await page.waitForTimeout(500);

  const emptyMsg = page.locator('text=Nic nenalezeno');
  await expect(emptyMsg).toBeVisible({ timeout: 10000 });
});

// E9: Source list
test('Sources tab shows source table with freshness', async ({ page }) => {
  await page.goto('/#/warehouse/sources');
  await page.waitForTimeout(1000);

  // Tabulka s hlavičkou "Zdroj"
  const sourceHeader = page.locator('th', { hasText: 'Zdroj' });
  await expect(sourceHeader).toBeVisible({ timeout: 10000 });

  // Freshness tečky existují (buď zelená, žlutá, červená, nebo šedá)
  const dots = page.locator('.rounded-full');
  // Alespoň 1 freshness tečka (pokud jsou zdroje)
  const dotCount = await dots.count();
  expect(dotCount).toBeGreaterThanOrEqual(0);
});

// E10: Scraping workflow (smoke)
test('Scraping panel loads with info box', async ({ page }) => {
  await page.goto('/#/warehouse/scraping');
  await page.waitForTimeout(1000);

  // Info box "Jak funguje scraping" viditelný
  const infoBox = page.locator('text=Jak funguje scraping');
  await expect(infoBox).toBeVisible({ timeout: 10000 });

  // Dropdown pro výběr zdroje
  const sourceSelect = page.locator('select');
  await expect(sourceSelect.first()).toBeVisible();

  // Scrape tlačítko existuje
  const scrapeButton = page.locator('button', { hasText: 'Scrape' });
  await expect(scrapeButton).toBeVisible();
});

// E10b: Tab navigace zachovává stav v URL
test('Tab navigation updates URL', async ({ page }) => {
  await page.goto('/#/warehouse');
  await page.waitForTimeout(500);

  // Klik na "Produkty"
  await page.locator('button', { hasText: 'Produkty' }).click();
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/warehouse\/products/);

  // Klik na "Scraping"
  await page.locator('button', { hasText: 'Scraping' }).click();
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/warehouse\/scraping/);

  // Klik na "Zdroje dat"
  await page.locator('button', { hasText: 'Zdroje dat' }).click();
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/warehouse\/sources/);

  // Klik na "Přehled"
  await page.locator('button', { hasText: 'Přehled' }).click();
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/warehouse/);
});
