@echo off
chcp 65001 >nul
echo Windows 방화벽에서 8080 포트(MAPS AI Agent)를 여는 중입니다...
echo 이 창을 "관리자 권한으로 실행"하지 않았다면 실패할 수 있습니다.
netsh advfirewall firewall add rule name="MAPS AI Agent 8080" dir=in action=allow protocol=TCP localport=8080
echo.
echo 완료되었습니다. 위에 오류가 없었다면 다른 PC에서 접속할 수 있습니다.
pause
