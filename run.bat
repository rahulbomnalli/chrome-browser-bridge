@echo off
setlocal
title Antigravity Chrome Bridge

cd /d "%~dp0"

echo ============================================================
echo   * Antigravity Chrome Bridge
echo ============================================================
echo.

:: 1. Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [X] Error: Node.js is not installed or not in your PATH!
    echo     Please install Node.js from https://nodejs.org/ to run the bridge.
    echo.
    pause
    exit /b 1
)

:: 2. Check dependencies
if not exist "node_modules\" (
    echo [*] Setting up dependencies - running once...
    call npm install --silent
    echo [*] Done!
    echo.
)

:: 3. Check if server is already running
node -e "const http=require('http'); const req=http.get('http://127.0.0.1:8765/status', res=>{process.exit(res.statusCode===200?0:1)}); req.on('error', ()=>process.exit(1)); req.setTimeout(1000, ()=>{req.destroy(); process.exit(1)});" >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] Bridge Server is ALREADY RUNNING on http://127.0.0.1:8765
) else (
    echo [*] Starting Bridge Server...
    start "Antigravity Chrome Bridge Server" node server.js
    timeout /t 2 /nobreak >nul 2>&1
    echo [OK] Bridge Server started!
)

echo.
echo ============================================================
echo   Bridge is active!
echo   Load unpacked extension if not already added:
echo   %~dp0extension
echo ============================================================
echo.

timeout /t 3 >nul 2>&1
exit /b 0
