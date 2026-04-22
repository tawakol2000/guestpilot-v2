import { chromium } from 'playwright';
const url = process.argv[2];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', m => console.log('[console]', m.type(), m.text()));
await page.goto(url, { waitUntil: 'domcontentloaded' });
// sample scroll at many timepoints
for (const ms of [200, 600, 1000, 1500, 2000, 3000, 4500]) {
  await page.waitForTimeout(ms === 200 ? 200 : 400);
  const info = await page.evaluate(() => {
    const scrollers = Array.from(document.querySelectorAll('[class*="overflow-auto"]'));
    return scrollers.map(s => ({
      cls: s.className.slice(0, 80),
      scrollTop: s.scrollTop,
      scrollHeight: s.scrollHeight,
      clientHeight: s.clientHeight,
    }));
  });
  console.log(`t=${ms}ms`, JSON.stringify(info));
}
await browser.close();
