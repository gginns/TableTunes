@echo off
echo ============================================
echo   TableTunes - Setup
echo ============================================
echo.

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found!
    echo Please install Node.js from https://nodejs.org
    echo Then re-run this script.
    pause
    exit /b 1
)

echo [OK] Node.js found
echo.
echo Installing dependencies (this may take a minute)...
echo.

npm install

if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Check the errors above.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Setup complete! Run start.bat to launch.
echo ============================================
pause
