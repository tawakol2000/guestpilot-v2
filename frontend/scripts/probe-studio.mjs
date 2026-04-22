import { chromium } from 'playwright';
const url = process.argv[2];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForLoadState('networkidle');
await page.waitForTimeout(2500);
const info = await page.evaluate(() => {
  const q = (sel) => Array.from(document.querySelectorAll(sel));
  const text = (el) => (el?.innerText ?? '').slice(0, 200);
  return {
    scrollTopOnLoad: document.querySelector('main [class*="overflow-auto"]')?.scrollTop ?? null,
    hasSessionDiff: q('[data-session-diff-card], article').filter(a => /session artifacts touched|session diff|what landed/i.test(a.innerText)).map(text),
    hasTestPipeline: q('[data-testid="test-pipeline-result"]').map(el => text(el)),
    hasSuggestedFix: q('[data-suggested-fix-id]').length,
    hasAudit: q('article').filter(a => /audit report|gaps across/i.test(a.innerText)).length,
    hasAdvisory: q('div').filter(d => /edited the coordinator/i.test(d.innerText)).length,
    tabsHtml: q('[role="tab"], nav a, nav button').map(text).slice(0, 20),
    unsupportedCards: document.body.innerText.match(/unsupported card: [a-z-]+/gi) ?? [],
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
