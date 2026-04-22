import { chromium } from 'playwright';
const url = process.argv[2];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForLoadState('networkidle');
await page.waitForTimeout(2500);
const info = await page.evaluate(() => {
  const q = (sel) => Array.from(document.querySelectorAll(sel));
  return {
    scrollTop: document.querySelector('main [class*="overflow-auto"]')?.scrollTop ?? null,
    sessionDiffCount: q('[data-testid="session-diff-card"]').length,
    sessionDiffText: q('[data-testid="session-diff-card"]').map(e => e.innerText.slice(0, 300)),
    stateSnapshotCount: q('[data-studio-card="state-snapshot"]').length,
    auditReportArticles: q('article').filter(a => /audit report|gaps/i.test(a.innerText)).length,
    advisoryText: q('div').filter(d => /recent-edit|edited the coordinator/i.test(d.innerText)).map(d => d.innerText.slice(0, 100)).slice(0,3),
    scrollerCount: q('[class*="overflow-auto"]').length,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
