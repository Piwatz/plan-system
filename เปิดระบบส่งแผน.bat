@echo off
title Lesson Plan System - keep this window open while teachers use the system
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto :nonode
if not exist "node_modules\express" goto :install
if not exist "node_modules\eslint-scope" goto :install
:run
echo Starting the lesson plan system...
echo Keep this window open. Close it to stop the system.
node --disable-warning=ExperimentalWarning server.js --open %*
pause
exit /b 0

:install
echo First run: downloading the required files. This needs internet and takes about 1 minute.
call npm install
if errorlevel 1 goto :fail
goto :run

:nonode
echo Node.js is not installed on this computer.
echo Please install Node.js 24 LTS from https://nodejs.org then open this file again.
pause
exit /b 1

:fail
echo Could not download the required files. Check the internet connection and try again.
pause
exit /b 1
