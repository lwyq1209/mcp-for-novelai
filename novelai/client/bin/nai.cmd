@echo off
rem nai: the command line of MCP for NovelAI (novelai\src\cli.mjs; nai --help, nai skill).
rem Shipped as <installation>\resources\bin\nai.cmd of the app and kept as novelai\client\bin\nai.cmd in a source
rem checkout. Put its folder on PATH (a copy or link of this file elsewhere does not find the app). It runs the
rem command-line bundle that belongs to it with the executable that belongs to it as Node:
rem   app:    resources\mcp\novelai-cli.mjs with <installation>\MCP for NovelAI.exe
rem   source: <client>\dist-mcp\novelai-cli.mjs with node_modules\electron\dist\<path.txt>
rem ELECTRON_RUN_AS_NODE=1 is set only inside this script (setlocal) for that one process.
setlocal
for %%I in ("%~dp0..") do set "NAI_BASE=%%~fI"
if exist "%NAI_BASE%\mcp\novelai-cli.mjs" goto packaged
if exist "%NAI_BASE%\dist-mcp\novelai-cli.mjs" goto source
if exist "%NAI_BASE%\package.json" if exist "%NAI_BASE%\electron\" goto notbuilt
echo {"ok":false,"error":{"code":"nai_not_found","message":"nai does not stand in an app or a client checkout."}}
exit /b 4

:notbuilt
echo {"ok":false,"error":{"code":"nai_not_built","message":"This source checkout has no built command line: run npm --prefix novelai/client run build."}}
exit /b 4

:packaged
set "NAI_SCRIPT=%NAI_BASE%\mcp\novelai-cli.mjs"
for %%I in ("%NAI_BASE%\..") do set "NAI_EXE=%%~fI\MCP for NovelAI.exe"
goto run

:source
set "NAI_SCRIPT=%NAI_BASE%\dist-mcp\novelai-cli.mjs"
set "NAI_ELECTRON="
if exist "%NAI_BASE%\node_modules\electron\path.txt" set /p NAI_ELECTRON=<"%NAI_BASE%\node_modules\electron\path.txt"
if not defined NAI_ELECTRON goto noruntime
set "NAI_EXE=%NAI_BASE%\node_modules\electron\dist\%NAI_ELECTRON%"

:run
if not exist "%NAI_EXE%" goto noruntime
set "ELECTRON_RUN_AS_NODE=1"
"%NAI_EXE%" "%NAI_SCRIPT%" %*
exit /b %ERRORLEVEL%

:noruntime
echo {"ok":false,"error":{"code":"nai_runtime_missing","message":"The executable that runs nai is missing."}}
exit /b 4
