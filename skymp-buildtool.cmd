@echo off
setlocal
node "%~dp0skymp-buildtool\cli.mjs" %*
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%
