const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const NAV_TIMEOUT = 60_000;
const ACTION_TIMEOUT = 25_000;

const VFS_ORIGIN = 'https://passports.vfsglobal.com';
const SESSION_KEYS = [
  'JWT',
  'csk_str',
  'loginStatus',
  'logged_email',
  'ip',
  'last_Access_details',
  'application_configuration',
  'appSchema',
  'fullAppSchema',
];
const SLOT_API_PATTERN = /CheckIsSlotAvailable/i;

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

function sessionFile(profileRoot) {
  return path.join(profileRoot, 'session.json');
}

function loadSession(profileRoot) {
  const f = sessionFile(profileRoot);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveSession(profileRoot, entries) {
  fs.writeFileSync(sessionFile(profileRoot), JSON.stringify(entries, null, 2));
}

async function launchContext(profileRoot, { headless }) {
  return chromium.launchPersistentContext(userDir(profileRoot), {
    headless,
    viewport: { width: 1280, height: 1000 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

async function addSessionRestoreScript(ctx, entries) {
  if (!entries || Object.keys(entries).length === 0) return;
  const json = JSON.stringify(entries);
  const origin = JSON.stringify(VFS_ORIGIN);
  await ctx.addInitScript(`
    (function () {
      try {
        if (location.origin !== ${origin}) return;
        var entries = ${json};
        for (var k in entries) {
          try { sessionStorage.setItem(k, entries[k]); } catch (e) {}
        }
      } catch (e) {}
    })();
  `);
}

async function captureSessionStorage(page) {
  return page.evaluate(
    (keys) => {
      const out = {};
      for (const k of keys) {
        const v = sessionStorage.getItem(k);
        if (v !== null) out[k] = v;
      }
      return out;
    },
    SESSION_KEYS
  );
}

async function dismissCookies(page) {
  const btn = page.getByRole('button', { name: /accept only necessary/i }).first();
  if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
    await btn.click({ timeout: 5000 }).catch(() => {});
  }
}

// The Angular app shows a full-screen ngx-ui-loader overlay during async work.
// It intercepts pointer events, so clicks fail until it's gone. Wait it out.
async function waitForLoaderGone(page, timeout = 30_000) {
  const overlay = page.locator('.ngx-overlay.loading-foreground');
  await overlay
    .first()
    .waitFor({ state: 'hidden', timeout })
    .catch(() => {});
}

async function openLoginFlow(profileRoot, loginUrl, dashboardUrl, { onSuccess, onClosed }) {
  // IMPORTANT: do NOT restore sessionStorage here. A stale JWT makes the SPA
  // think it's authed, bounce to /dashboard, fail validation, bounce back to
  // /login — and our init script re-injects on every load → refresh loop.
  // Login must always start clean.
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
        try {
          const entries = await captureSessionStorage(p);
          saveSession(profileRoot, entries);
        } catch (_) {}
        onSuccess && onSuccess();
        await new Promise((r) => setTimeout(r, 1500));
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
  await waitForLoaderGone(page);
  const combo = page.getByRole('combobox').nth(comboIndex);
  await combo.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
  await combo.click({ timeout: ACTION_TIMEOUT });
  await page.waitForTimeout(400);
  const re = new RegExp(regexEscape(optionText), 'i');
  const opt = page.getByRole('option', { name: re }).first();
  await opt.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
  await opt.click({ timeout: ACTION_TIMEOUT });
  log && log(`  ${label}: ${optionText}`);
  await page.waitForTimeout(400);
}

function groupTargets(targets) {
  const map = new Map();
  for (const t of targets) {
    const key = `${t.location}||${t.category}`;
    if (!map.has(key)) {
      map.set(key, { location: t.location, category: t.category, subs: [] });
    }
    map.get(key).subs.push(t);
  }
  return Array.from(map.values());
}

function makeResult(target) {
  return {
    target: target.name,
    timestamp: new Date().toISOString(),
    status: 'unknown',
    detail: '',
    screenshot: null,
    url: null,
  };
}

async function snap(page, profileRoot, prefix) {
  const shot = path.join(screenshotsDir(profileRoot), `${prefix}-${Date.now()}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  return shot;
}

// Walk one (location, category) group. For each sub-category, change the
// sub-category dropdown, wait for the CheckIsSlotAvailable XHR, record result.
async function checkGroup(profileRoot, cfg, group, { headless = false, log = () => {} } = {}) {
  const session = loadSession(profileRoot);
  const ctx = await launchContext(profileRoot, { headless });
  if (session) await addSessionRestoreScript(ctx, session);

  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(ACTION_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  // Latest payload bucket — reset before each sub-category selection.
  let latestPayload = null;
  page.on('response', async (resp) => {
    if (SLOT_API_PATTERN.test(resp.url())) {
      try {
        latestPayload = await resp.json();
      } catch (_) {
        latestPayload = { _parseError: true };
      }
    }
  });

  const results = group.subs.map(makeResult);

  try {
    log(`[group ${group.location} / ${group.category}] checking ${group.subs.length} sub(s)`);

    await page.goto(cfg.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await dismissCookies(page);

    const dashHead = page.getByRole('heading', { name: /^dashboard$/i }).first();
    const loginHead = page.getByRole('heading', { name: /^sign in$/i }).first();
    await Promise.race([
      dashHead.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {}),
      loginHead.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {}),
    ]);

    if (/\/login/i.test(page.url()) || !(await dashHead.isVisible().catch(() => false))) {
      const shot = await snap(page, profileRoot, 'needs-login');
      for (const r of results) {
        r.status = 'needs_login';
        r.detail = 'session expired or not logged in';
        r.url = page.url();
        r.screenshot = shot;
      }
      return results;
    }

    await waitForLoaderGone(page);
    await page.getByRole('button', { name: /start new booking/i }).click({ timeout: ACTION_TIMEOUT });
    await page.waitForURL(/application-detail/i, { timeout: NAV_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
    await waitForLoaderGone(page);

    // Pick centre and category ONCE.
    await pickFromCombobox(page, 0, group.location, log, 'centre');
    await pickFromCombobox(page, 1, group.category, log, 'category');

    // Iterate sub-categories on the SAME page.
    for (let i = 0; i < group.subs.length; i++) {
      const sub = group.subs[i];
      const r = results[i];
      log(`  [${sub.name}]`);
      latestPayload = null;

      try {
        await pickFromCombobox(page, 2, sub.subCategory, log, 'sub-category');

        const deadline = Date.now() + 15_000;
        while (!latestPayload && Date.now() < deadline) {
          await page.waitForTimeout(250);
        }

        r.url = page.url();

        if (!latestPayload) {
          r.status = 'unknown';
          r.detail = 'CheckIsSlotAvailable response not seen within 15s';
          r.screenshot = await snap(page, profileRoot, 'unknown');
        } else {
          const earliest = latestPayload.earliestDate;
          const slotList = Array.isArray(latestPayload.earliestSlotLists)
            ? latestPayload.earliestSlotLists
            : [];
          if (earliest != null || slotList.length > 0) {
            r.status = 'SLOT_FOUND';
            r.detail = `earliestDate=${earliest} slots=${slotList.length}`;
            r.screenshot = await snap(page, profileRoot, 'slot');
            r.payload = latestPayload;
          } else {
            r.status = 'no_slots';
            r.detail =
              (latestPayload.error && latestPayload.error.description) || 'no slots';
          }
        }
      } catch (err) {
        r.status = 'error';
        r.detail = (err && err.message) || String(err);
        r.screenshot = await snap(page, profileRoot, 'error');
      }
    }
  } catch (err) {
    for (const r of results) {
      if (r.status === 'unknown') {
        r.status = 'error';
        r.detail = (err && err.message) || String(err);
      }
    }
    if (!page.isClosed()) await snap(page, profileRoot, 'error-group');
  } finally {
    try {
      if (!page.isClosed()) {
        const entries = await captureSessionStorage(page);
        if (entries && entries.JWT) saveSession(profileRoot, entries);
      }
    } catch (_) {}
    await ctx.close().catch(() => {});
  }
  return results;
}

async function runOnce(profileRoot, cfg, opts) {
  const groups = groupTargets(cfg.targets);
  const all = [];
  for (const g of groups) {
    const rs = await checkGroup(profileRoot, cfg, g, opts);
    all.push(...rs);
    if (rs.some((r) => r.status === 'needs_login')) break;
  }
  return all;
}

module.exports = {
  runOnce,
  checkGroup,
  openLoginFlow,
  screenshotsDir,
  userDir,
  loadSession,
  saveSession,
};
