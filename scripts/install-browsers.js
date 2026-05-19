#!/usr/bin/env node
// Install Playwright Chromium into a project-local folder so we can bundle
// it into the Electron installer via electron-builder extraResources.
//
// Default: install for the CURRENT platform → ./playwright-browsers
// --win  : install for Windows x64 (cross-download from any host)
//          → ./playwright-browsers-win (used by `npm run build:win`)
const { spawnSync } = require('child_process');
const path = require('path');

const isWin = process.argv.includes('--win');
const target = path.resolve(
  __dirname,
  '..',
  isWin ? 'playwright-browsers-win' : 'playwright-browsers'
);

process.env.PLAYWRIGHT_BROWSERS_PATH = target;
if (isWin) {
  process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = 'win64';
}

const cli = path.join(
  path.dirname(require.resolve('playwright-core/package.json')),
  'cli.js'
);

console.log(
  `Installing Playwright Chromium (${isWin ? 'win64' : 'current platform'}) to ${target} ...`
);

const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(r.status || 0);
