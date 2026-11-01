@echo off
chcp 65001 >nul
setlocal
rem Switch Cline/OpenCode profiles. Run from the PROJECT root, not from this folder.
rem Profiles: local, local7, local-q5, local14-hq, cloud, cloud-ollama, status, verify
set "SCRIPT=%~dp0scripts\ai-profile.mjs"

where node >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Node.js не найден в PATH.
  echo Поставьте Node.js LTS 22.13 или новее: https://nodejs.org/
  echo Без Node 22.13+ работает только OpenCode-часть: запись Cline требует node:sqlite.
  exit /b 2
)

node --no-warnings "%SCRIPT%" %*
endlocal
