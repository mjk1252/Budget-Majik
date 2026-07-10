@echo off
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
start "" /min cmd /c "npx electron ."
