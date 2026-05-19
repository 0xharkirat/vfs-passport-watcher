const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const NAV_TIMEOUT = 60_000;
const ACTION_TIMEOUT = 20_000;
const SLOT_SETTLE_MS = 3000;

function userDir(profileRoot) {
  const dir = path.join(profileRoot, 'browser-profile');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function screenshotsDir(profileRoot) {
  const dir = path.join(profileRoot, 'screenshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function launchContext(profileRoot, { headless }) {
  return chromium.launchPersistentContext(userDir(profileRoot), {
    headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

async function dismissCookies(page) {
  const acceptOnly = page.getByRole('button', { name: /accept only necessary/i }).first();
  if ((await acceptOnly.count()) > 0 && (await acceptOnly.isVisible().catch(() => false))) {
    await acceptOnly.click({ timeout: 5000 }).catch(() => {});
  }
}

async function openLoginFlow(profileRoot, loginUrl, dashboardUrl, { onSuccess, onClosed }) {
  const ctx = await launchContext(profileRoot, { headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

  let closed = false;
  const poll = setInterval(async () => {
    if (closed) return;
    try {
      const p = ctx.pages()[0];
      if (!p || p.isClosed()) return;
      if (/\/dashboard/i.test(p.url())) {
        clearInterval(poll);
        onSuccess && onSuccess();
        await ctx.close().catch(() => {});
      }
    } catch (_) {}
  }, 1000);

  ctx.on('close', () => {
    closed = true;
    clearInterval(poll);
    onClosed && onClosed();
  });
  return ctx;
}

function regexEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function pickFromCombobox(page, comboIndex, optionText, log, label) {
  const combo = page.getByRole('combobox').nth(comboIndex);
  await combo.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
  await combo.click({ timeout: ACTION_TIMEOUT });
  await page.waitForTimeout(400);
  const re = new RegExp(regexEscape(optionText), 'i');
  const opt = page.getByRole('option', { name: re }).first();
  await opt.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
  await opt.click({ timeout: ACTION_TIMEOUT });
  log && log(`  ${label}: ${optionText}`);
  await page.waitForTimeout(600);
}

async function detectSession(page, dashboardUrl, log) {
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await dismissCookies(page);
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
  const url = page.url();
  if (/\/login/i.test(url)) return { ok: false, url };
  const dashboardHeading = page.getByRole('heading', { name: /dashboard/i }).first();
  if ((await dashboardHeading.count()) === 0) {
    log && log(`  not on dashboard (url=${url})`);
    return { ok: false, url };
  }
  return { ok: true, url };
}

async function checkTarget(profileRoot, cfg, target, { headless = true, log = () => {} } = {}) {
  const ctx = await launchContext(profileRoot, { headless });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(ACTION_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  const result = {
    target: target.name,
    timestamp: new Date().toISOString(),
    status: 'unknown',
    detail: '',
    screenshot: null,
    url: null,
  };

  try {
    log(`[${target.name}] checking`);

    const session = await detectSession(page, cfg.dashboardUrl, log);
    if (!session.ok) {
      result.status = 'needs_login';
      result.detail = 'session expired or not logged in';
      result.url = session.url;
      const shot = path.join(screenshotsDir(profileRoot), `needs-login-${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      result.screenshot = shot;
      return result;
    }

    const startBtn = page.getByRole('button', { name: /start new booking/i });
    await startBtn.click({ timeout: ACTION_TIMEOUT });
    await page.waitForURL(/application-detail/i, { timeout: NAV_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});

    await pickFromCombobox(page, 0, target.location, log, 'centre');
    await pickFromCombobox(page, 1, target.category, log, 'category');
    await pickFromCombobox(page, 2, target.subCategory, log, 'sub-category');

    await page.waitForTimeout(SLOT_SETTLE_MS);

    const probe = await page.evaluate(() => {
      const alert = document.querySelector('[role="alert"]');
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent.trim() === 'Continue'
      );
      return {
        alertText: alert ? alert.textContent.trim() : null,
        continueDisabled: btn ? btn.disabled : null,
        continueAriaDisabled: btn ? btn.getAttribute('aria-disabled') : null,
        continueFound: !!btn,
        url: location.href,
      };
    });

    result.url = probe.url;
    const noSlotAlert =
      probe.alertText && /no appointment slots/i.test(probe.alertText);
    const continueOn =
      probe.continueFound &&
      probe.continueDisabled === false &&
      probe.continueAriaDisabled !== 'true';

    if (continueOn) {
      result.status = 'SLOT_FOUND';
      result.detail = 'Continue button enabled';
      const shot = path.join(screenshotsDir(profileRoot), `slot-${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      result.screenshot = shot;
    } else if (noSlotAlert) {
      result.status = 'no_slots';
      result.detail = 'no slots alert present';
    } else {
      result.status = 'unknown';
      result.detail = `alertText=${JSON.stringify(probe.alertText)} continueDisabled=${probe.continueDisabled}`;
      const shot = path.join(screenshotsDir(profileRoot), `unknown-${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      result.screenshot = shot;
    }
  } catch (err) {
    result.status = 'error';
    result.detail = (err && err.message) || String(err);
    const shot = path.join(screenshotsDir(profileRoot), `error-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    result.screenshot = shot;
  } finally {
    await ctx.close().catch(() => {});
  }
  return result;
}

async function runOnce(profileRoot, cfg, opts) {
  const out = [];
  for (const target of cfg.targets) {
    const r = await checkTarget(profileRoot, cfg, target, opts);
    out.push(r);
    if (r.status === 'needs_login') break;
  }
  return out;
}

module.exports = { runOnce, checkTarget, openLoginFlow, screenshotsDir, userDir };
