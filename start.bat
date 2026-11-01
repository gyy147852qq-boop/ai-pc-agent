@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"
title AI PC Agent

set "NODE="
where node >nul 2>nul
if not errorlevel 1 set "NODE=node"

if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE for /d %%D in ("%USERPROFILE%\.workbuddy-ai\binaries\node\versions\*") do if exist "%%D\node.exe" set "NODE=%%D\node.exe"

if not defined NODE (
  echo.
  echo   [!] Node.js not found.
  echo       Install Node.js 22 or newer first: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo   Starting AI PC Agent ...
"%NODE%" server.js %*
if errorlevel 1 pause
