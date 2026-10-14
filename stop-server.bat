@echo off
setlocal
title Stop Antigravity Chrome Bridge

echo [*] Stopping Chrome Bridge Server...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

timeout /t 1 /nobreak >nul 2>&1
echo [OK] Bridge Server stopped.
timeout /t 2 /nobreak >nul 2>&1
