@echo off
setlocal enabledelayedexpansion
REM Review Form Assistant - Windows setup.
REM
REM Double-click this file. It checks Node, runs the tests and the permission
REM audit, starts the local server, opens the setup page for your API key, and
REM opens the extension folder in Explorer.
REM
REM It does NOT install the extension into Brave and changes no browser setting.
REM Chromium does not allow a script to do that. The last steps are yours.

cd /d "%~dp0"
set "PORT=8787"

echo.
echo Review Form Assistant - setup
echo Project: %cd%
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo STOPPED: Node.js is not installed. Get the LTS build from https://nodejs.org then run this again.
  pause
  exit /b 1
)

for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo STOPPED: Node is too old. This needs Node 20 or newer.
  pause
  exit /b 1
)
for /f %%v in ('node -v') do echo Node %%v: ok

echo Running the offline test suite...
node --test >"%TEMP%\rfa-test.log" 2>&1
if errorlevel 1 (
  type "%TEMP%\rfa-test.log"
  echo.
  echo STOPPED: tests failed. Do not install this.
  pause
  exit /b 1
)
echo Tests: passed

echo Running the permission audit...
node scripts\audit.mjs >"%TEMP%\rfa-audit.log" 2>&1
if errorlevel 1 (
  type "%TEMP%\rfa-audit.log"
  echo.
  echo STOPPED: audit found problems. Do not install this.
  pause
  exit /b 1
)
echo Audit: passed, 0 findings

echo Starting the local server on 127.0.0.1:%PORT% ...
start "Review Form Assistant server" /min cmd /c "node server.js > server.log 2>&1"
timeout /t 3 /nobreak >nul

start "" "http://127.0.0.1:%PORT%/setup"
start "" explorer "%cd%\extension"
echo brave://extensions| clip

echo.
echo Automated part is done.
echo.
echo   1. The setup page just opened. Paste your OpenAI API key there and save.
echo   2. Open a new Brave tab and paste brave://extensions (already on your clipboard).
echo   3. Turn on Developer mode, top right.
echo   4. Click Load unpacked, then choose the "extension" folder now open in Explorer.
echo.
echo Steps 2 to 4 cannot be scripted. Brave requires a person to load an
echo unpacked extension. That restriction is why this is safe to hand around.
echo.
echo To stop the server, close the minimised "Review Form Assistant server" window.
echo.
pause
