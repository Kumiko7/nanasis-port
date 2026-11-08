@echo off
rem Story viewer: runs on the bundled Python in .\python (no install needed).
cd /d "%~dp0"
set PY="%~dp0python\python.exe"
if not exist data\cues.json %PY% scripts\sync.py --no-pull
start "" http://127.0.0.1:7777
%PY% scripts\server.py
