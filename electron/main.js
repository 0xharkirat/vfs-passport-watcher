const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// Point Playwright at our bundled Chromium before requiring checker.
// In dev: ./playwright-browsers (downloaded by scripts/install-browsers.js).
// In packaged app: <resourcesPath>/playwright-browsers (via electron-builder extraResources).
process.env.PLAYWRIGHT_BROWSERS_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'playwright-browsers')
  : path.join(__dirname, '..', 'playwright-browsers');

const cfgMod = require('../src/config');
const checker = require('../src/checker');

let mainWindow = null;
let tray = null;
let loginCtx = null;
let timer = null;
let running = false;
let cfg = null;
let lastResults = [];
let nextCheckAt = null;
let lastCheckAt = null;
const logBuf = [];
const MAX_LOG = 500;

function appRoot() {
  return app.getAppPath();
}
function profileRoot() {
  return app.getPath('userData');
}

function log(line) {
  const entry = `[${new Date().toLocaleTimeString()}] ${line}`;
  logBuf.push(entry);
  if (logBuf.length > MAX_LOG) logBuf.shift();
  if (mainWindow) mainWindow.webContents.send('log', entry);
}

function pushStatus() {
  if (!mainWindow) return;
  mainWindow.webContents.send('status', {
    running,
    intervalMinutes: cfg && cfg.checkIntervalMinutes,
    lastResults,
    nextCheckAt,
    lastCheckAt,
  });
}

function createTrayIcon() {
  const img = nativeImage.createEmpty();
  return img;
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('VFS Passport Watcher');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show', click: () => mainWindow && mainWindow.show() },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 620,
    title: 'VFS Passport Watcher',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('close', (e) => {
    if (running) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    logBuf.forEach((l) => mainWindow.webContents.send('log', l));
    pushStatus();
  });
}

async function runCycle() {
  if (loginCtx) {
    log('skip cycle: login window open (shared browser profile)');
    if (running) scheduleNext();
    return;
  }
  if (!cfg) cfg = cfgMod.load(profileRoot(), appRoot());
  lastCheckAt = Date.now();
  nextCheckAt = null;
  pushStatus();
  log(`cycle start (${cfg.targets.length} targets)`);
  try {
    const results = await checker.runOnce(profileRoot(), cfg, { headless: false, log });
    lastResults = results;
    for (const r of results) {
      log(`  ${r.target}: ${r.status} — ${r.detail}`);
    }
    const hit = results.find((r) => r.status === 'SLOT_FOUND');
    const needsLogin = results.find((r) => r.status === 'needs_login');
    if (hit) {
      onSlotFound(hit);
    } else if (needsLogin) {
      log('session expired — login required');
      notify('Login required', 'VFS session expired. Click Login in the app.');
    }
  } catch (err) {
    log(`cycle error: ${err.message || err}`);
  } finally {
    pushStatus();
    if (running) scheduleNext();
  }
}

function scheduleNext() {
  const minutes = (cfg && cfg.checkIntervalMinutes) || 5;
  const jitterMs = ((cfg && cfg.jitterSeconds) || 0) * 1000 * Math.random();
  const delay = minutes * 60_000 + jitterMs;
  nextCheckAt = Date.now() + delay;
  log(`next check in ~${Math.round(delay / 1000)}s`);
  if (timer) clearTimeout(timer);
  timer = setTimeout(runCycle, delay);
  pushStatus();
}

function startWatching() {
  if (running) return;
  running = true;
  log('watching started');
  pushStatus();
  runCycle();
}

function stopWatching() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  nextCheckAt = null;
  log('watching stopped');
  pushStatus();
}

function notify(title, body) {
  try {
    new Notification({ title, body, urgency: 'critical' }).show();
  } catch (_) {}
}

function onSlotFound(result) {
  log(`*** SLOT FOUND: ${result.target} ***`);
  notify('VFS slot available!', `${result.target} — open the app to book.`);
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    if (mainWindow.flashFrame) mainWindow.flashFrame(true);
    mainWindow.webContents.send('slot-found', result);
  }
}

ipcMain.handle('get-config', () => cfg);
ipcMain.handle('save-config', (_e, next) => {
  cfg = next;
  cfgMod.save(profileRoot(), cfg);
  log('config saved');
  return cfg;
});
ipcMain.handle('start', () => {
  if (loginCtx) {
    log('cannot start: login window still open — close it first');
    return;
  }
  startWatching();
});
ipcMain.handle('stop', () => stopWatching());
ipcMain.handle('check-now', () => runCycle());

ipcMain.handle('simulate-slot', () => {
  const fake = {
    target: (cfg && cfg.targets && cfg.targets[0] && cfg.targets[0].name) || 'TEST',
    timestamp: new Date().toISOString(),
    status: 'SLOT_FOUND',
    detail: 'SIMULATED — no real slot, alarm test',
    screenshot: null,
    url: 'simulated://test',
  };
  lastResults = [fake];
  onSlotFound(fake);
  pushStatus();
});

ipcMain.handle('open-login', async () => {
  if (loginCtx) return { ok: false, error: 'login window already open' };
  if (running) return { ok: false, error: 'stop watching first before opening login' };
  if (!cfg) cfg = cfgMod.load(profileRoot(), appRoot());
  log('opening login window — sign in manually; window auto-closes on dashboard');
  try {
    loginCtx = await checker.openLoginFlow(
      profileRoot(),
      cfg.loginUrl,
      cfg.dashboardUrl,
      {
        onSuccess: () => {
          log('login succeeded — session saved');
          notify('VFS login saved', 'You can now click Start Watching.');
        },
        onClosed: () => {
          loginCtx = null;
          log('login window closed');
          pushStatus();
        },
      }
    );
    return { ok: true };
  } catch (err) {
    loginCtx = null;
    log(`login error: ${err.message || err}`);
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('open-folder', () => {
  shell.openPath(profileRoot());
});

ipcMain.handle('open-last-screenshot', () => {
  const last = lastResults.find((r) => r.screenshot);
  if (last && fs.existsSync(last.screenshot)) shell.openPath(last.screenshot);
});

app.whenReady().then(() => {
  cfg = cfgMod.load(profileRoot(), appRoot());
  createWindow();
  createTray();
});

app.on('window-all-closed', (e) => {
  if (running) e.preventDefault();
  else app.quit();
});
