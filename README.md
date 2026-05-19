# VFS Passport Watcher

Watches [passports.vfsglobal.com (AUS → ZAP)](https://passports.vfsglobal.com/aus/en/zap/login) for South African passport appointment slots from Australia, polls every few minutes in the background, and raises a loud alarm + Windows toast notification the moment a slot becomes visible.

Built for non-technical users: install once, click **Login → Start**, leave it running.

## What it does

- Opens a real Chromium browser (via Playwright) on a schedule
- Navigates the booking flow for each configured target (e.g. *Adult Tourist Passport — Sydney*, *Child Passport — Sydney*)
- Detects either the "no appointment slots are available" message or a visible date picker
- On a hit: shows the app window, flashes the taskbar, plays a beeping alarm, fires a Windows notification, saves a screenshot

## Windows install (one-time)

1. **Install Node.js LTS** from <https://nodejs.org> (accept defaults).
2. **Download this repo:** click the green **Code** button on GitHub → **Download ZIP** → extract to e.g. `Documents\vfs-watcher`.
   *(Or `git clone` if you have Git.)*
3. **Double-click `setup.bat`** in the extracted folder. It runs `npm install` and downloads Playwright's Chromium browser. Takes 2–5 minutes.

## Running it

1. **Double-click `start.bat`.** The app window opens.
2. Click **1. Login to VFS.** A browser opens to the VFS login page. Sign in manually (handle any captcha). When you reach the dashboard, **close the browser** — the session is saved.
3. Click **2. Start Watching.** The app now checks every 5 minutes in the background. You can minimise the window; it keeps running.
4. When a slot is found:
   - The app window pops to the front and the taskbar icon flashes
   - A loud beeping alarm plays
   - A Windows notification appears
   - Click **Stop** to silence, then go book the slot manually in the VFS browser

## Configuration

Edit interval in the UI, or open the data folder (link in the app) and edit `config.json`:

```json
{
  "loginUrl": "https://passports.vfsglobal.com/aus/en/zap/login",
  "checkIntervalMinutes": 5,
  "jitterSeconds": 30,
  "targets": [
    { "name": "Adult Tourist Passport — Sydney", "location": "Sydney", "category": "Passport", "subCategory": "Tourist Passport" },
    { "name": "Child Passport — Sydney", "location": "Sydney", "category": "Passport", "subCategory": "Child Passport" }
  ]
}
```

The location / category / subCategory strings are matched case-insensitively against the dropdown options on the VFS site. If the site renames a category, edit the string here.

## If a check shows `unknown` or `error`

The VFS site sometimes changes its DOM. When status is `unknown` or `error`:

1. Click **Open last screenshot** in the app — you'll see what the browser saw.
2. If the dropdown labels changed, update `config.json` to match.
3. If you see a Cloudflare challenge, click **Login** again to solve it manually; the session refreshes.

Screenshots and logs live in the data folder (click **Open data folder** in the app).

## Important caveats

- **Use responsibly.** This is a personal monitor for *your own* appointment search, not a high-frequency scraper. Default cadence (5 min + jitter) is well below abuse territory but excessive polling can get your IP rate-limited.
- **Slot detection is heuristic.** If you get a false positive, treat the screenshot as ground truth and tighten the matcher in `src/checker.js`.
- **Session expires.** When VFS logs you out, the app raises a "Login required" notification — click **Login** to refresh.

## Tech

- [Electron](https://www.electronjs.org/) — desktop shell, tray, notifications
- [Playwright](https://playwright.dev/) — browser automation with a persistent Chromium profile
- Pure HTML/CSS/JS UI, no framework

## License

MIT.
