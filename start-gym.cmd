@echo off
rem Runs Gradient Gym on this PC with Cloudflare's local dev server, using the portable Node.js in tools\node.
cd /d "%~dp0"
if exist "%~dp0tools\node\node.exe" set "PATH=%~dp0tools\node;%PATH%"
if not exist node_modules call npm install
call npx wrangler d1 migrations apply gradient-gym --local

rem Locally, scheduled jobs don't fire by themselves. This small window runs the cron once a minute
rem (house agents, spar deadlines) and closes itself about 10 minutes after the gym stops.
start "Gradient Gym cron" /min powershell -NoProfile -Command "$f = 0; while ($f -lt 10) { Start-Sleep 60; try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3000/cdn-cgi/local/scheduled?cron=*+*+*+*+*' | Out-Null; $f = 0 } catch { $f++ } }"

echo Opening http://localhost:3000 ...
start "" http://localhost:3000
call npx wrangler dev
pause
