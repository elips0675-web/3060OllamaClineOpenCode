@echo off
chcp 65001 >nul
title 3060 - температура и лимит мощности
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================================
echo  Температура видеокарты и лимит мощности
echo ============================================================
echo.

set "ARG=%~1"
if /i "%ARG%"=="reset" goto reset
if not "%ARG%"=="" goto setlimit

node scripts\gpu-temp.mjs
echo.
echo  Поставить лимит:    11-Температура.bat 130
echo  Вернуть заводской:  11-Температура.bat reset
echo  Изменение лимита требует прав администратора.
goto end

:setlimit
net session >nul 2>&1
if errorlevel 1 goto noadmin
node scripts\gpu-temp.mjs --set %ARG%
goto end

:reset
net session >nul 2>&1
if errorlevel 1 goto noadmin
node scripts\gpu-temp.mjs --reset
goto end

:noadmin
echo  Нужны права администратора: закрой окно и запусти файл
echo  правым кликом - "Запуск от имени администратора".
echo  Показать температуру без прав можно так: 11-Температура.bat
goto end

:end
echo.
pause
endlocal
