@echo off
setlocal EnableExtensions
title Simple DAW
cd /d "%~dp0"
set "APPDIR=%~dp0app"
set "VENV=%APPDIR%\.venv"
set "PYX=%VENV%\Scripts\python.exe"
set "PYW=%VENV%\Scripts\pythonw.exe"

if exist "%PYX%" (
  "%PYX%" -c "import dawdreamer, numpy, soundfile, soxr" >nul 2>&1 && goto run
)

echo.
echo   Setting up Simple DAW. This only happens the first time and takes a minute or two.
echo.
set "PY="
for %%V in (3.12 3.13 3.11 3.14) do (
  if not defined PY (
    py -%%V -c "import sys" >nul 2>&1 && set "PY=py -%%V"
  )
)
if not defined PY (
  python -c "import sys; raise SystemExit(0 if (3,11) <= sys.version_info[:2] <= (3,14) else 1)" >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo   Simple DAW needs Python 3.11, 3.12, 3.13 or 3.14.
  echo   Install Python 3.12 from https://www.python.org/downloads/ and run this file again.
  echo.
  pause
  exit /b 1
)
if not exist "%PYX%" (
  %PY% -m venv "%VENV%"
  if errorlevel 1 goto fail
)
echo   Installing the plugin engine...
"%PYX%" -m pip install --disable-pip-version-check -q -r "%APPDIR%\requirements.txt"
if errorlevel 1 goto fail

:run
start "" "%PYW%" "%APPDIR%\server.py"
exit /b 0

:fail
echo.
echo   Setup didn't finish. Check your internet connection and run this file again.
echo.
pause
exit /b 1
