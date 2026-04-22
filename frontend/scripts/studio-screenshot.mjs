#!/usr/bin/env node
// @ts-check
/**
 * Studio demo screenshot driver (sprint studio-demo-fix-loop).
 *
 * Usage:
 *   node frontend/scripts/studio-screenshot.mjs --url "http://localhost:3000/dev-login?tenantId=…&conversationId=…"
 *
 * Launches chromium at 1440x900, navigates to the demo dev-login URL,
 * waits for the Studio conversation to load, and writes:
 *
 *   /tmp/studio-shots/<YYYYMMDD-HHMMSS>/00-full.png
 *   /tmp/studio-shots/<YYYYMMDD-HHMMSS>/01-header.png
 *   /tmp/studio-shots/<YYYYMMDD-HHMMSS>/02-msg-01.png … NN-msg-NN.png
 *   /tmp/studio-shots/<YYYYMMDD-HHMMSS>/90-history-drawer.png (if ledger button exists)
 *   /tmp/studio-shots/<YYYYMMDD-HHMMSS>/console.txt
 *   /tmp/studio-shots/<YYYYMMDD-HHMMSS>/warnings.txt
 *
 * Dead simple on purpose — re-run after every fix.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    args[k] = rest.join('=') || true;
  }
  return args;
}

function tsStamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const url = args.url;
  if (!url || typeof url !== 'string') {
    console.error('usage: studio-screenshot.mjs --url <dev-login-url>');
    process.exit(2);
  }

  const outDir = join('/tmp/studio-shots', tsStamp());
  await mkdir(outDir, { recursive: true });
  console.log(`[shots] outDir = ${outDir}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const consoleLines = [];
  const warningLines = [];
  page.on('console', (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    consoleLines.push(line);
    const lower = line.toLowerCase();
    if (
      msg.type() === 'error' ||
      msg.type() === 'warning' ||
      lower.includes('unknown part') ||
      lower.includes('unsupported card') ||
      lower.includes('hydration') ||
      lower.includes('did not match')
    ) {
      warningLines.push(line);
    }
  });
  page.on('pageerror', (err) => {
    const line = `[pageerror] ${err.message}`;
    consoleLines.push(line);
    warningLines.push(line);
  });

  try {
    console.log(`[shots] nav ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
    // Dev-login redirects to /?tab=studio&conversationId=… — wait for that.
    await page.waitForURL((u) => u.pathname === '/' && u.search.includes('tab=studio'), {
      timeout: 30_000,
    });
    // Give the Studio chat a moment to hydrate + fetch initial messages.
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
    await page.waitForTimeout(3500);

    // Wait for at least one message row or the empty state.
    const messageSelector = '[data-testid="studio-chat"] [class*="px-5"], main [class*="py-4"]';
    try {
      await page.waitForSelector(messageSelector, { timeout: 15_000 });
    } catch {
      console.warn('[shots] no message rows matched selector; continuing');
    }

    // 00 full page
    await page.screenshot({ path: join(outDir, '00-full.png'), fullPage: true });

    // 01 header — viewport top
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await page.screenshot({
      path: join(outDir, '01-header.png'),
      clip: { x: 0, y: 0, width: 1440, height: 220 },
    });

    // Find all assistant + user message rows. The Studio MessageRow wraps each
    // in a div with class "px-5 py-4" (see studio-chat.tsx). We prefer a
    // structural selector over testids because the component does not expose
    // per-row testids.
    const rowHandles = await page
      .locator('main div.px-5.py-4, div.px-5.py-4')
      .filter({ hasText: /You|Agent/i })
      .elementHandles()
      .catch(() => []);

    console.log(`[shots] message rows found: ${rowHandles.length}`);

    for (let i = 0; i < rowHandles.length; i++) {
      const h = rowHandles[i];
      const idx = String(i + 1).padStart(2, '0');
      try {
        await h.scrollIntoViewIfNeeded({ timeout: 5_000 });
        await page.waitForTimeout(150);
        await h.screenshot({ path: join(outDir, `${String(i + 2).padStart(2, '0')}-msg-${idx}.png`) });
      } catch (err) {
        console.warn(`[shots] msg ${idx} screenshot failed: ${err?.message}`);
      }
    }

    // 90 history-drawer — look for anything that says "Version" / "History".
    try {
      const trigger = page
        .getByRole('button', { name: /versions?|history|ledger/i })
        .first();
      if (await trigger.isVisible({ timeout: 2_000 })) {
        await trigger.click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(outDir, '90-history-drawer.png'), fullPage: true });
      }
    } catch {
      // optional — no drawer is fine
    }

    // Dump logs
    await writeFile(join(outDir, 'console.txt'), consoleLines.join('\n'));
    await writeFile(join(outDir, 'warnings.txt'), warningLines.join('\n'));

    console.log(`[shots] done. ${rowHandles.length} message rows captured.`);
    console.log(`[shots] warnings: ${warningLines.length}`);
    console.log(`[shots] outDir: ${outDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[shots] fatal:', err);
  process.exit(1);
});
