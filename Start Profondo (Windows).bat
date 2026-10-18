@echo off
cd /d "%~dp0app"
start "" http://localhost:8765
where python >nul 2>nul && (python -m http.server 8765 --bind 127.0.0.1) || (npx --yes http-server -p 8765 -a 127.0.0.1 -c-1)
