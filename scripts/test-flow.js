#!/usr/bin/env node
// Dev harness: drive checker.js the same way electron/main.js does, but from
// the CLI so we can test on any platform without the packaged app.
//
//   node scripts/test-flow.js login   → opens headed browser, you sign in,
//                                        window auto-closes on dashboard,
//                                        session.json is captured
//   node scripts/test-flow.js check   → restores session, walks booking flow,
//                                        prints results JSON
//   node scripts/test-flow.js folder  → prints the test profile folder contents
const path = require('path');
const os = require('os');
const fs = require('fs');

// Same as electron/main.js (dev branch): point Playwright at bundled Chromium.
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'playwright-browsers');

const checker = require('../src/checker');

const profileRoot = path.join(os.tmpdir(), 'vfs-watcher-test');
fs.mkdirSync(profileRoot, { recursive: true });

const cfg = {
  loginUrl: 'https://passports.vfsglobal.com/aus/en/zap/login',
  dashboardUrl: 'https://passports.vfsglobal.com/aus/en/zap/dashboard',
  targets: [
    { name: 'Adult Tourist Passport — Sydney', location: 'Sydney', category: 'Passport', subCategory: 'Tourist Passport' },
    { name: 'Child Passport — Sydney', location: 'Sydney', category: 'Passport', subCategory: 'Child Passport' },
  ],
};

function listFolder() {
  console.log(`\n=== profile: ${profileRoot} ===`);
  const walk = (dir, depth = 0) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      const pad = '  '.repeat(depth);
      if (st.isDirectory()) {
        console.log(`${pad}${name}/`);
        if (depth < 1) walk(full, depth + 1);
      } else {
        console.log(`${pad}${name}  (${st.size} bytes)`);
      }
    }
  };
  walk(profileRoot);
  const sf = path.join(profileRoot, 'session.json');
  if (fs.existsSync(sf)) {
    const keys = Object.keys(JSON.parse(fs.readFileSync(sf, 'utf8')));
    console.log(`\nsession.json keys: ${keys.join(', ')}`);
  } else {
    console.log('\nsession.json: NOT PRESENT');
  }
}

async function main() {
  const mode = process.argv[2] || 'check';
  if (mode === 'login') {
    console.log('Opening login window — sign in manually. Closes on dashboard.');
    await new Promise((resolve) => {
      checker.openLoginFlow(profileRoot, cfg.loginUrl, cfg.dashboardUrl, {
        onSuccess: () => console.log('>>> LOGIN SUCCESS — session captured'),
        onClosed: () => {
          console.log('>>> login window closed');
          resolve();
        },
      });
    });
    listFolder();
  } else if (mode === 'check') {
    const log = (m) => console.log(m);
    const results = await checker.runOnce(profileRoot, cfg, { headless: false, log });
    console.log('\n=== RESULTS ===');
    console.log(JSON.stringify(results.map(({ payload, ...r }) => r), null, 2));
    listFolder();
  } else if (mode === 'folder') {
    listFolder();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
