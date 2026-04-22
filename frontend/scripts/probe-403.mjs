import { chromium } from 'playwright';
const url = process.argv[2];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const failed = [];
page.on('response', (r) => {
  if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);
console.log(JSON.stringify(failed, null, 2));
await browser.close();
