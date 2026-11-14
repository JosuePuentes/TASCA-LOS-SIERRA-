@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Instala Node.js desde https://nodejs.org y vuelve a abrir este archivo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Preparando Tasca Los Sierra...
  call npm install
  if errorlevel 1 (
    echo No se pudo preparar el sistema.
    pause
    exit /b 1
  )
)
echo.
echo  Tasca Los Sierra
echo  Abre http://localhost:3000
echo  Para cerrar el sistema, cierra esta ventana.
echo.
start "" cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:3000"
call npm start
pause
