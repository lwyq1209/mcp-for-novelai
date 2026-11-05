@echo off
rem MCP for NovelAI launcher for Windows.
rem
rem   Double-click this file, or run:  novelai\scripts\start-client.cmd [--no-build] [--inpaint-diagnostics]
rem
rem It runs "node novelai\scripts\start-client.mjs --detach": the launcher (build, then the
rem Electron host) runs in the background without a console window, so it keeps running after
rem this window, the calling shell, or an agent session ends. This window only reports whether
rem the host became ready. Stop the client by closing its own window.
rem Logs: novelai\.tmp\client-launch\  (launcher-status.log records every attempt).
setlocal EnableExtensions DisableDelayedExpansion
"%SystemRoot%\System32\where.exe" /q node
if errorlevel 1 goto nonode
node "%~dp0start-client.mjs" --detach %*
set "NAI_RC=%ERRORLEVEL%"
goto done

:nonode
echo Node.js was not found in PATH.
set "NAI_RC=9"

:done
rem Keep the result readable when double-clicked; returns at once when stdin is not a console.
if "%NAI_RC%"=="0" goto pause_ok
"%SystemRoot%\System32\timeout.exe" /t 60 2>nul
exit /b %NAI_RC%

:pause_ok
"%SystemRoot%\System32\timeout.exe" /t 5 2>nul
exit /b 0
