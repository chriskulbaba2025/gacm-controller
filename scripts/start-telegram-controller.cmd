@echo off
cd /d C:\Users\kulba\Desktop\prysm-gacm-mcp
if not exist logs mkdir logs
npm run telegram >> logs\telegram-controller.log 2>&1
