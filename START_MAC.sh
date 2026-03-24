#!/bin/bash
echo ""
echo "  🌾 FarEX AI Server v2.1"
echo "  ─────────────────────────────"

# Install if needed
if [ ! -d "node_modules" ]; then
  echo "  Installing packages (first time)..."
  npm install
fi

# Set API key
export ANTHROPIC_API_KEY="PASTE_YOUR_API_KEY_HERE"

if [ "$ANTHROPIC_API_KEY" = "PASTE_YOUR_API_KEY_HERE" ]; then
  echo "  ⚠  No API key — Demo mode"
  echo "  Edit START_MAC.sh to add your key"
else
  echo "  ✓  API Key loaded"
fi

echo ""
echo "  Open: http://localhost:3000"
echo "  Ctrl+C to stop"
echo ""
node server.js
