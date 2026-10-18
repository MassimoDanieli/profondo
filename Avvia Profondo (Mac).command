#!/bin/bash
# Double-click on macOS: serves the app on http://localhost:8765 and opens it in Chrome (or the default browser).
cd "$(dirname "$0")/app"
PORT=8765
( sleep 1; open -a "Google Chrome" "http://localhost:$PORT" 2>/dev/null || open "http://localhost:$PORT" ) &
echo "Profondo → http://localhost:$PORT  (close this window to stop)"
python3 -m http.server $PORT --bind 127.0.0.1
