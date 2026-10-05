@echo off
title Lesson Plan System - DEMO with sample data
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto :nonode
if not exist "node_modules\eslint-scope" if exist "node_modules\express" (
  echo New version: downloading the new required files. This needs internet.
  call npm install
  if errorlevel 1 goto :fail
)
if not exist "node_modules\express" (
  echo First run: downloading the required files. This needs internet and takes about 1 minute.
  call npm install
  if errorlevel 1 goto :fail
)
if not exist "data-demo\app.db" (
  echo Creating sample school data...
  node --disable-warning=ExperimentalWarning scripts\seed-demo.js
)
echo DEMO mode: all names are fictional. Real data is not touched.
echo To start the demo fresh, delete the folder data-demo and open this file again.
node --disable-warning=ExperimentalWarning server.js --data data-demo --demo --port 3100 --open
pause
exit /b 0

:nonode
echo Node.js is not installed on this computer.
echo Please install Node.js 24 LTS from https://nodejs.org then open this file again.
pause
exit /b 1

:fail
echo Could not download the required files. Check the internet connection and try again.
pause
exit /b 1
