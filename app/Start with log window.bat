@echo off
rem Runs Simple DAW with a visible log window. Use this if something goes wrong.
title Simple DAW (log window)
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run "Start Simple DAW.bat" once first to finish setup.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" server.py
pause
