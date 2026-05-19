const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const NAV_TIMEOUT = 60_000;
const ACTION_TIMEOUT = 20_000;

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

async function openLoginFlow(profileRoot, loginUrl, onClosed) {
  const ctx = await launchContext(profileRoot, { headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  ctx.on('close', () => onClosed && onClosed());
  return ctx;
}

async function clickByText(page, text, log) {
  const variants = Array.isArray(text) ? text : [text];
  for (const t of variants) {
    const exact = page.getByText(t, { exact: true }).first();
    if (await exact.count() > 0 && await exact.isVisible().catch(() => false)) {
      await exact.click({ timeout: ACTION_TIMEOUT });
      return true;
    }
    const loose = page.getByText(t, { exact: false }).first();
    if (await loose.count() > 0 && await loose.isVisible().catch(() => false)) {
      await loose.click({ timeout: ACTION_TIMEOUT });
      return true;
    }
  }
  log && log(`  could not click any of: ${variants.join(' | ')}`);
  return false;
}

async function selectDropdown(page, label, value, log) {
  const combos = page.getByRole('combobox');
  const n = await combos.count();
  for (let i = 0; i < n; i++) {
    const c = combos.nth(i);
    if (!(await c.isVisible().catch(() => false))) continue;
    await c.click({ timeout: ACTION_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(400);
    const opt = page.getByRole('option', { name: new RegExp(value, 'i') }).first();
    if (await opt.count() > 0) {
      await opt.click({ timeout: ACTION_TIMEOUT });
      log && log(`  selected ${label}: ${value}`);
      return true;
    }
    const opt2 = page.getByText(value, { exact: false }).first();
    if (await opt2.count() > 0 && await opt2.isVisible().catch(() => false)) {
      await opt2.click({ timeout: ACTION_TIMEOUT });
      log && log(`  selected ${label}: ${value}`);
      return true;
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
  log && log(`  no dropdown matched for ${label}=${value}`);
  return false;
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
    log(`[${target.name}] navigating`);
    await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});

    if (/login/i.test(page.url())) {
      result.status = 'needs_login';
      result.detail = 'session expired or not logged in';
      result.url = page.url();
      const shot = path.join(screenshotsDir(profileRoot), `needs-login-${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      result.screenshot = shot;
      return result;
    }

    await clickByText(page, ['Start New Booking', 'Book Appointment', 'Schedule Appointment', 'Book Now'], log);
    await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});

    await selectDropdown(page, 'location', target.location, log);
    await page.waitForTimeout(800);
    await selectDropdown(page, 'category', target.category, log);
    await page.waitForTimeout(800);
    await selectDropdown(page, 'subCategory', target.subCategory, log);
    await page.waitForTimeout(800);

    await clickByText(page, ['Continue', 'Next', 'Proceed'], log);
    await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(2000);

    const pageText = (await page.textContent('body').catch(() => '')) || '';
    const lower = pageText.toLowerCase();
    const noSlots = cfg.noSlotsTexts.some((t) => lower.includes(t.toLowerCase()));

    result.url = page.url();

    if (noSlots) {
      result.status = 'no_slots';
      result.detail = 'no slots available';
    } else {
      const hasCalendar =
        (await page.locator('[role="grid"], .calendar, [class*="calendar" i], [class*="date" i]').count()) > 0;
      const hasDateButtons =
        (await page.locator('button:not([disabled])').filter({ hasText: /^\d{1,2}$/ }).count()) > 0;

      if (hasCalendar || hasDateButtons) {
        result.status = 'SLOT_FOUND';
        result.detail = 'calendar/date elements visible without no-slots message';
        const shot = path.join(screenshotsDir(profileRoot), `slot-${Date.now()}.png`);
        await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        result.screenshot = shot;
      } else {
        result.status = 'unknown';
        result.detail = 'no-slots message absent but no calendar detected';
        const shot = path.join(screenshotsDir(profileRoot), `unknown-${Date.now()}.png`);
        await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        result.screenshot = shot;
      }
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
