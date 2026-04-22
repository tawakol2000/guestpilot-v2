import { chromium } from 'playwright';
const url = process.argv[2];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForLoadState('networkidle');
await page.waitForTimeout(2000);
// Find plan-checklist → rows → glyph
const glyphs = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('article'))
    .filter(a => a.innerText.includes('Build plan') || a.innerText.includes('Plan proposed'));
  if (rows.length === 0) return { found: false };
  const row = rows[0];
  const ul = row.querySelector('ul');
  const lis = Array.from(ul?.querySelectorAll('li') ?? []);
  return { found: true, count: lis.length, glyphs: lis.map(li => li.innerText.slice(0, 80)) };
});
console.log(JSON.stringify(glyphs, null, 2));
await browser.close();
