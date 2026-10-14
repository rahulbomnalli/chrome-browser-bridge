@echo off
setlocal
title Antigravity Chrome Bridge - Autostart Setup

cd /d "%~dp0"
echo ============================================================
echo   * Antigravity Chrome Bridge - System Boot Autostart
echo ============================================================
echo.

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET_VBS=%~dp0start-daemon.vbs"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\AntigravityChromeBridge.lnk"

echo [*] Creating silent background startup shortcut...

powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT_PATH%'); $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"%TARGET_VBS%\"'; $s.WorkingDirectory = '%~dp0'; $s.Description = 'Antigravity Chrome Bridge Background Daemon'; $s.Save()"

if exist "%SHORTCUT_PATH%" (
    echo [OK] Autostart successfully configured!
    echo      The bridge server will now start silently in the background
    echo      every time you log in to Windows.
) else (
    echo [X] Could not create startup shortcut automatically.
)

echo.
pause
