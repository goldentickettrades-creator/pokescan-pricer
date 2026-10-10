@echo off
cd /d "%~dp0"
echo PokeScan Pricer running at http://localhost:8917  (close this window to stop)
start "" http://localhost:8917
python -m http.server 8917 --bind 127.0.0.1
