━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  FarEX Server v2.1 — SETUP GUIDE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1 — Copy your app
  Copy index.html → into the /public folder
  (Create the /public folder if it doesn't exist)

STEP 2 — Add your API key
  Open START_WINDOWS.bat in Notepad
  Find this line:
    set ANTHROPIC_API_KEY=PASTE_YOUR_API_KEY_HERE
  Replace with your real key:
    set ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxx

STEP 3 — Run
  Double-click START_WINDOWS.bat
  Open browser → http://localhost:3000

STEP 4 — Use on your phone
  Your laptop and phone must be on the SAME WiFi
  Find your laptop's IP address:
    Windows: open CMD → type ipconfig → look for IPv4
    e.g. 192.168.1.10
  On your phone open: http://192.168.1.10:3000

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TROUBLESHOOTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

"node is not recognized"
  → Install Node.js from https://nodejs.org (LTS version)
  → Restart the command window after install

"Port 3000 already in use"
  → Open Task Manager → find node.exe → End task
  → Or change PORT=3001 in server.js line 4

Phone can't connect
  → Check Windows Firewall: allow Node.js on private networks
  → Make sure phone and laptop are on same WiFi network

API returns errors
  → Double check your API key starts with sk-ant-api03-
  → Check https://console.anthropic.com for usage/credits
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
