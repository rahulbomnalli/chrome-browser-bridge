@echo off
title Launch Chrome with Remote Debugging
echo ====================================================
echo Launching Chrome with Remote Debugging on port 9222...
echo ====================================================

set CHROME_PATH="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist %CHROME_PATH% set CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME_PATH% set CHROME_PATH="%LocalAppData%\Google\Chrome\Application\chrome.exe"

start "" %CHROME_PATH% --remote-debugging-port=9222 --user-data-dir="%LocalAppData%\Google\Chrome\DebugProfile" http://localhost:3000
echo Chrome started with remote debugging on port 9222.
