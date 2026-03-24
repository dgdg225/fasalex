@echo off
title FarEX Server
color 0A
echo.
echo  ████████╗ █████╗ ██████╗ ███████╗██╗  ██╗
echo  ██╔════╝██╔══██╗██╔══██╗██╔════╝╚██╗██╔╝
echo  █████╗  ███████║██████╔╝█████╗   ╚███╔╝
echo  ██╔══╝  ██╔══██║██╔══██╗██╔══╝   ██╔██╗
echo  ██║     ██║  ██║██║  ██║███████╗██╔╝ ██╗
echo  ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
echo.
echo  FarEX AI Server v2.1 - Starting up...
echo  ─────────────────────────────────────────
echo.

REM Check if node_modules exists
IF NOT EXIST node_modules (
    echo  [1/2] Installing packages (first time only)...
    npm install
    echo.
)

REM Set API key - PASTE YOUR KEY BELOW between the quotes
REM Example: set ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxx
set ANTHROPIC_API_KEY=PASTE_YOUR_API_KEY_HERE

IF "%ANTHROPIC_API_KEY%"=="PASTE_YOUR_API_KEY_HERE" (
    echo  ⚠  API KEY NOT SET — Running in Demo Mode
    echo  Edit START_WINDOWS.bat and paste your key where it says PASTE_YOUR_API_KEY_HERE
    echo.
) ELSE (
    echo  ✓  API Key loaded
    echo.
)

echo  [2/2] Starting server...
echo  ─────────────────────────────────────────
echo  Open your browser: http://localhost:3000
echo  Keep this window open while using FarEX!
echo  Press Ctrl+C to stop the server.
echo  ─────────────────────────────────────────
echo.

node server.js

echo.
echo  Server stopped. Press any key to exit.
pause >nul
