@echo off
chcp 65001 >nul
title SwiftMatch AI - установка локальных моделей (RTX 3060)
setlocal EnableExtensions
set "HERE=%~dp0"

echo ============================================================
echo  Установка локального ИИ-агента (Ollama + RTX 3060)
echo ============================================================
echo.

where ollama >nul 2>nul
if errorlevel 1 goto no_ollama

echo [1/3] Проверка видеокарты...
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
if errorlevel 1 echo   [ВНИМАНИЕ] nvidia-smi не найден: модель пойдёт на CPU и будет медленной.
echo.

echo [2/3] Переменные окружения Ollama (нужны для GPU и экономии VRAM)...
set "OLLAMA_FLASH_ATTENTION=1"
set "OLLAMA_KV_CACHE_TYPE=q8_0"
set "OLLAMA_MAX_LOADED_MODELS=2"
set "OLLAMA_NUM_PARALLEL=1"
set "OLLAMA_KEEP_ALIVE=30m"
setx OLLAMA_FLASH_ATTENTION 1 >nul
setx OLLAMA_KV_CACHE_TYPE q8_0 >nul
setx OLLAMA_MAX_LOADED_MODELS 2 >nul
setx OLLAMA_NUM_PARALLEL 1 >nul
setx OLLAMA_KEEP_ALIVE 30m >nul
echo   flash attention: да, KV-кэш: q8_0, параллельных запросов: 1
echo.

echo [3/3] Выберите профиль под вашу видеопамять:
echo.
echo   [1] 14B q4      ~9.0 GB VRAM  - ВАША КАРТА (3060 12 ГБ). Рекомендуется.
echo   [2] 14B q6     ~12.0 GB VRAM  - только для 16 ГБ VRAM, на 12 ГБ не влезет
echo   [3] 7B  q8      ~7.6 GB VRAM  - 8 ГБ карты, только ВМЕСТО 14B, не вместе с ним
echo   [4] 1.5B tiny   ~1.0 GB VRAM  - автодополнение рядом с 14B (можно ставить сразу)
echo   [5] 7B  q5_K_M  ~5.4 GB VRAM  - легче q8: +2 ГБ запаса VRAM, качество ниже q8
echo.
echo  ВАЖНО: OLLAMA_MAX_LOADED_MODELS=2 разрешает держать две модели сразу.
echo  Годная пара - 14B + 1.5B (~10.1 ГБ). Пара 14B + 7B = ~17.6 ГБ больше 12 ГБ:
echo  начнётся CPU/GPU split и падение до 3-5 ток/с. Ставьте 7B ВМЕСТО 14B.
echo.
echo  q5_K_M - компромисс: если 7B q8 помещается, берите q8; q5 нужен, когда
echo  рядом должно остаться место браузеру, Docker или 1.5B (~6.5 ГБ вместо 7.6).
echo.
echo  Qwen2.5-Coder - модель конца 2024 года. Если в ollama.com/library уже
echo  есть более свежее семейство coder в размере 14B, берите его тем же
echo  способом: свой Modelfile со строкой num_ctx (см. 10-Приложения.txt, п.5.1).
echo.
echo   Enter = профиль 1. Скрипт можно запускать несколько раз:
echo   сначала [1], потом [4] (автодополнение).
echo.
set /p choice=Профиль [1-5]:
if "%choice%"=="" set "choice=1"
set "FAILED=0"

if "%choice%"=="1" call :install qwen2.5-coder:14b                 swiftmatch-coder-14b     Modelfile-14b-q4
if "%choice%"=="2" call :install qwen2.5-coder:14b-instruct-q6_K   swiftmatch-coder-14b-hq  Modelfile-14b-q6
if "%choice%"=="3" call :install qwen2.5-coder:7b-instruct-q8_0    swiftmatch-coder-7b      Modelfile-7b-q8
if "%choice%"=="4" call :install qwen2.5-coder:1.5b                swiftmatch-coder-tiny    Modelfile-tiny
if "%choice%"=="5" call :install qwen2.5-coder:7b-instruct-q5_K_M  swiftmatch-coder-7b-q5   Modelfile-7b-q5

if "%FAILED%"=="1" goto fail

echo.
echo ============================================================
echo  Готово. Что сделать дальше:
echo ============================================================
echo  1. Закройте Ollama в системном трее и запустите снова,
echo     иначе новые переменные окружения не подхватятся.
echo  2. Проверьте список:  ollama list
echo  3. Замер скорости:    03-Замер-скорости.bat
echo  4. Убедитесь, что модель целиком на GPU:  ollama ps
echo     В колонке PROCESSOR должно быть "100%% GPU".
echo  5. Переключение Cline+OpenCode одной командой (из корня ПРОЕКТА):
echo     "%~dp0switch-ai.bat" local      (14B q4, ctx 12288)
echo     "%~dp0switch-ai.bat" local-q5   (7B q5_K_M, ctx 16384)
echo     Перед этим закройте VS Code. Подробно - 12-Переключение-моделей.txt.
echo.
echo  Вручную в Cline: провайдер Ollama, Base URL http://localhost:11434,
echo  Model ID swiftmatch-coder-14b, Context Window 12288
echo  (для профиля [5] - Model ID swiftmatch-coder-7b-q5, Context 16384).
echo  Автодополнение в Continue: Model ID swiftmatch-coder-tiny.
echo ============================================================
pause
exit /b 0

:install
echo.
echo --- Скачивание базовой модели %~1 (может занять 10-20 минут) ---
ollama pull %~1
if errorlevel 1 (
  echo   [ОШИБКА] не удалось скачать %~1.
  echo   Если тег не найден, выполните: ollama pull qwen2.5-coder:14b
  echo   и замените строку FROM в %HERE%models\%~3 на этот тег.
  set "FAILED=1"
  exit /b 1
)
echo --- Сборка %~2 из %~3 ---
ollama create %~2 -f "%HERE%models\%~3"
if errorlevel 1 (
  echo   [ОШИБКА] ollama create не удался. Проверьте файл %HERE%models\%~3
  set "FAILED=1"
  exit /b 1
)
echo   [ok] модель %~2 создана
exit /b 0

:fail
echo.
echo ============================================================
echo  [ОШИБКА] Установка НЕ завершена: модель не создана.
echo ============================================================
echo  Причина - в красном тексте выше. Частые случаи:
echo   - нет интернета или тег не найден:
echo       ollama pull qwen2.5-coder:14b, затем снова этот файл;
echo   - мало места на диске C: (нужно ~12 ГБ на модели и кэш);
echo   - Ollama не запущена: значок в трее, затем повторить.
echo.
echo  Блок «Готово. Что сделать дальше» намеренно не печатается:
echo  без модели он врёт про успех.
pause
exit /b 1

:no_ollama
echo [ОШИБКА] ollama.exe не найден в PATH.
echo Установите Ollama с https://ollama.com/download и перезапустите этот файл.
pause
exit /b 1
