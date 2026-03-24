# KrushiEx — Railway Deployment

## Files
```
krushiex-server/
├── server.js        ← Express server (Railway entry point)
├── package.json     ← Dependencies
└── public/
    └── index.html   ← Full KrushiEx app (self-contained)
```

## Deploy to Existing Railway Project

### Option A — Replace via Railway Dashboard
1. Go to railway.app → your `farex-server` project
2. Click **Settings** → **Source**
3. If GitHub-connected: push these files to your repo
4. If not: use Railway CLI (see Option B)

### Option B — Railway CLI
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to existing project
railway link

# Deploy
railway up
```

### Option C — GitHub Push (if repo connected)
```bash
# Copy these files into your existing repo
cp server.js /your-repo/
cp package.json /your-repo/
cp -r public/ /your-repo/

# Push
cd /your-repo
git add .
git commit -m "KrushiEx v3 — DeepGazer™ full platform"
git push
```
Railway auto-deploys on push.

## Environment Variables (not needed — API key is user-entered in app)

## Expected URL after deploy
https://farex-server-production.up.railway.app
→ Full KrushiEx app with GPS, camera, HTTPS ✅
