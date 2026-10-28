@echo off
rem Runs Cloudflare's wrangler CLI with the portable Node.js in tools\node.
rem Usage from this folder:  .\wrangler login   |   .\wrangler deploy   |   .\wrangler d1 ...
setlocal
cd /d "%~dp0"
if exist "%~dp0tools\node\node.exe" set "PATH=%~dp0tools\node;%PATH%"
call npx wrangler %*
