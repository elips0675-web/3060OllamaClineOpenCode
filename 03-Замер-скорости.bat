@echo off
chcp 65001 >nul
title SwiftMatch AI - замер скорости моделей
setlocal EnableExtensions

echo ============================================================
echo  Замер реальной скорости (токены/с)
echo ============================================================
echo.
echo  Первый запуск каждой модели дольше: она грузится в VRAM.
echo  Смотрите строки "prompt eval rate" и "eval rate" в конце ответа.
echo.

echo --- Модели, установленные у вас ---
ollama list
echo.

call :bench swiftmatch-coder-14b
echo.
echo  Выгружаю 14B из VRAM, чтобы 7B не легла поверх неё (14B + 7B = 17.6 ГБ ^> 12).
ollama stop swiftmatch-coder-14b >nul 2>nul
call :bench swiftmatch-coder-7b
echo.
echo  Выгружаю 7B q8: 7B q8 + 7B q5 = ~14 ГБ ^> 12.
ollama stop swiftmatch-coder-7b >nul 2>nul
call :bench swiftmatch-coder-7b-q5

echo ============================================================
echo  Как читать результат
echo ============================================================
echo  eval rate 25-35 ток/с  - 14B q4 нормально работает на 3060
echo  eval rate 40-55 ток/с  - 7B q5/q8 нормально, если ollama ps = 100%% GPU
echo  eval rate 3-5 ток/с    - модель НЕ влезла в VRAM, ушла на CPU
echo  eval rate 200+ ток/с   - это закешированный/короткий ответ, не показатель
echo.
echo  Проверка распределения: ollama ps
echo  Нужно "100%% GPU". Если "CPU/GPU split" - уменьшите num_ctx
echo  в models\Modelfile-14b-q4 (12288 -^> 8192) и пересоберите модель.
echo ============================================================
pause
exit /b 0

:bench
set "HAVE="
for /f "tokens=1" %%m in ('ollama list 2^>nul') do (
  if /i "%%m"=="%~1" set "HAVE=1"
  if /i "%%m"=="%~1:latest" set "HAVE=1"
)
if not defined HAVE (
  echo   [пропуск] %~1 не установлена
  goto :eof
)
echo.
echo --- %~1 ---
ollama run %~1 --verbose "Write a TypeScript function that groups an array of objects by a key. Include types and two usage examples."
echo.
goto :eof
