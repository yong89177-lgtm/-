@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo MAPS AI Agent 백엔드를 시작합니다...
echo 종료하려면 이 창을 닫지 말고 Ctrl+C 를 누르세요.
node server.js
pause
