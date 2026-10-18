#!/bin/sh
cd "$(dirname "$0")/app" && (sleep 1; xdg-open http://localhost:8765 >/dev/null 2>&1) & python3 -m http.server 8765 --bind 127.0.0.1
