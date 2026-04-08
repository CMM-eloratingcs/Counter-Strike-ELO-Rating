@echo off
REM ============================================================
REM  VRS ELO — Atualização automática diária
REM  Coleta partidas novas → recalcula ranking → publica no GitHub
REM ============================================================

SET HLTV_DIR=C:\Users\caiom\OneDrive\READET~1\HLTV
SET PYTHON=C:\Users\caiom\AppData\Local\Python\pythoncore-3.14-64\python.exe
SET NODE=node
SET LOG_DIR=%HLTV_DIR%\logs
SET DATESTAMP=%date:~6,4%%date:~3,2%%date:~0,2%
SET LOG_FILE=%LOG_DIR%\update_%DATESTAMP%.log

REM Cria pasta de logs se não existir
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo. >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"
echo  VRS ELO Update - %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

echo [%time%] Iniciando atualizacao VRS ELO...
echo [%time%] Iniciando atualizacao VRS ELO... >> "%LOG_FILE%"

cd /d "%HLTV_DIR%"

REM ── 1. Coleta partidas novas do HLTV (últimos 7 dias) ────────
echo [%time%] Buscando partidas novas no HLTV...
echo [%time%] Buscando partidas novas no HLTV... >> "%LOG_FILE%"

"%PYTHON%" "%HLTV_DIR%\hltv_fetcher.py" --days 7 --update --out "%HLTV_DIR%\matchdata.json"
echo [%time%] Fetcher finalizado com codigo %ERRORLEVEL% >> "%LOG_FILE%"

if %ERRORLEVEL% neq 0 (
    echo [%time%] ERRO: hltv_fetcher.py falhou. Abortando.
    echo [%time%] ERRO: hltv_fetcher.py falhou. >> "%LOG_FILE%"
    exit /b 1
)

echo [%time%] Partidas coletadas com sucesso.
echo [%time%] Partidas coletadas com sucesso. >> "%LOG_FILE%"

REM ── 2. Recalcula o ranking Elo ────────────────────────────────
echo [%time%] Calculando ranking Elo...
echo [%time%] Calculando ranking Elo... >> "%LOG_FILE%"

%NODE% "%HLTV_DIR%\elo_ranking.js" "%HLTV_DIR%\matchdata.json" "%HLTV_DIR%\elo_standings_delta.json" --delta >> "%LOG_FILE%" 2>&1

if %ERRORLEVEL% neq 0 (
    echo [%time%] ERRO: elo_ranking.js falhou. Abortando.
    echo [%time%] ERRO: elo_ranking.js falhou. >> "%LOG_FILE%"
    exit /b 1
)

echo [%time%] Ranking calculado com sucesso.
echo [%time%] Ranking calculado com sucesso. >> "%LOG_FILE%"

REM ── 3. Publica no GitHub Pages ────────────────────────────────
echo [%time%] Publicando no GitHub...
echo [%time%] Publicando no GitHub... >> "%LOG_FILE%"

git -C "%HLTV_DIR%" add -f elo_standings_delta.json >> "%LOG_FILE%" 2>&1
git -C "%HLTV_DIR%" commit -m "auto: update %date% %time:~0,5%" >> "%LOG_FILE%" 2>&1
git -C "%HLTV_DIR%" push origin main >> "%LOG_FILE%" 2>&1

if %ERRORLEVEL% neq 0 (
    echo [%time%] AVISO: git push falhou. Verifique conexao.
    echo [%time%] AVISO: git push falhou. >> "%LOG_FILE%"
    exit /b 1
)

echo [%time%] Publicado com sucesso!
echo [%time%] Publicado com sucesso! >> "%LOG_FILE%"
echo [%time%] Atualizacao concluida!
echo [%time%] Atualizacao concluida! >> "%LOG_FILE%"
