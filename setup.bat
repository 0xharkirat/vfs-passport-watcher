@echo off
setlocal
echo === VFS Passport Watcher: setup ===
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Install from https://nodejs.org (LTS), then re-run setup.bat.
  pause
  exit /b 1
)
echo Installing dependencies (this may take a few minutes)...
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)
echo.
echo Setup complete. Double-click start.bat to launch the app.
pause
