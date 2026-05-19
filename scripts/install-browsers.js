#!/usr/bin/env node
// Install Playwright Chromium into a project-local folder so we can bundle
// it into the Electron .exe via electron-builder extraResources.
const { spawnSync } = require('child_process');
const path = require('path');

const target = path.resolve(__dirname, '..', 'playwright-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = target;

const cli = path.join(
  path.dirname(require.resolve('playwright-core/package.json')),
  'cli.js'
);

console.log(`Installing Playwright Chromium to ${target} ...`);

const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(r.status || 0);
