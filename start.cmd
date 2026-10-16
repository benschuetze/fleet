@echo off
rem Claude Fleet: set up (if needed), start in the background and open in the browser.
rem The window closes by itself afterwards, Fleet keeps running.
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js is required: https://nodejs.org
  echo Or in PowerShell: winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
if not exist dist\fleet.cjs (
  echo Not built yet. Once: corepack enable ^&^& pnpm install ^&^& pnpm build
  pause
  exit /b 1
)
node dist\fleet.cjs setup %*
if errorlevel 1 pause
