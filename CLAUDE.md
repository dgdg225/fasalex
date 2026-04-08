# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Deployment Rules
- NEVER create new Railway projects
- NEVER run railway CLI commands
- Deployment = `git add` + `git commit` + `git push origin main`
- Railway auto-deploys from GitHub push to `dgdg225/fasalex`

## Project
- Railway project: brave-success
- Service: farex-server
- URL: www.fasalex.com
- GitHub: dgdg225/fasalex

## Session Rules
- After every session, auto-update `CONTINUITY.md` with a summary of changes made
- After every session, append new entries to `EXHIBIT_LOG.md` (patent evidence log)
- Both files live in the repo root
- Always include timestamp format: `YYYY-MM-DD HH:MM IST` on every session entry and every exhibit entry
- A git post-commit hook (`.git/hooks/post-commit`) auto-stamps both files on every commit — do not remove it

## Server-Side Only Files (never in GitHub repo)
- `exhibits.jsonl` — lives at `/app/exhibits.jsonl` on Railway server, created automatically on first scan. NEVER commit or create this file in the repo.
- `price_cache.json` — runtime cache, already in `.gitignore`

## API & Model Rules
- Use `claude-haiku-4-5-20251001` for ALL Claude API calls in server.js (not Sonnet, not Opus)
- CERT_SCALE = 1 (do not change canvas certificate scale)

## Project Overview

**FasalEx** (FarEX) is a single-page web app for AI-powered agricultural produce grading and market pricing. It uses Claude's vision API to analyze produce images against AGMARK standards and enriches results with live commodity prices.

## Running the App

```bash
# Set required API key (Windows)
set ANTHROPIC_API_KEY=sk-ant-api03-...
npm start

# Set required API key (macOS/Linux)
export ANTHROPIC_API_KEY=sk-ant-api03-...
npm start
```

The server starts on port 8080 (override with `PORT` env var). Access from phone on same WiFi via `http://<local-ip>:8080`.

Optional env vars:
- `REFRESH_SECRET` — secret for `/api/refresh-prices` endpoint (default: `fasalex2026`)

There are no tests, no build step, and no bundler — the app runs directly.

## Architecture

**Two runtime files:**

1. **`server.js`** — Pure Node.js HTTP server (does NOT use Express despite it being in package.json). Handles routing manually, serves static files, proxies Claude API calls, and aggregates live commodity prices from 5 external APIs (World Bank, USDA, EU AGRI, FAO, Open Exchange Rates).

2. **`public/index.html`** — 3500+ line all-in-one SPA (HTML + CSS + JS). No framework, no build tools. All app state lives in a global `S` object; user data is persisted to localStorage under key `fx10`.

**API Endpoints** (defined near end of `server.js`):
- `POST /api/identify` — Claude vision: quick produce identification from image
- `POST /api/analyze` — Claude vision: full grading with AGMARK standards, K-calibration, buyer contacts, GPS
- `GET /api/prices` — Aggregated live market prices with INR exchange rates
- `GET /api/health` — Health check (version, cache status, API key config)
- `GET /api/refresh-prices` — Manual price cache refresh (requires `?secret=...`)

**Frontend Pages** (toggled via `nav()` function in index.html):
`#page-splash` → `#page-welcome` (onboarding) → `#page-register` → `#page-home` → `#page-scan` → `#page-report` → `#page-share` → `#page-market` → `#page-profile`

## Key Implementation Details

- **Claude model used:** `claude-haiku-4-5-20251001` (Haiku for all API calls)
- **AGMARK grading data** is hardcoded in `server.js` (object `AGMARK_SRV`, ~lines 284–303) for 20+ commodities
- **Static price fallbacks** are hardcoded in `server.js` (`STATIC_FALLBACK`, ~lines 310–330) for when external APIs are unavailable
- **K-calibration:** Patent-pending formula `K = D_known/D_px` for size measurement using reference objects (credit card, SIM packet, ruler, etc.)
- **Price cache** is written to `price_cache.json` at runtime and auto-refreshed daily at 06:00 IST
- **GPS fallback** is Hospet, Karnataka (15.2624°N, 76.3823°E)
- Images are base64-encoded and sent directly to the Claude API; no file storage
- Certificate generation uses the Canvas API (CERT_SCALE=1) and downloads as PNG

## Adding or Changing Features

- All frontend page logic, CSS, and HTML live in `public/index.html` — search by page ID (e.g., `id="page-scan"`) or function name
- To add a new commodity to grading, update `AGMARK_SRV` and `STATIC_FALLBACK` in `server.js`
- The Claude prompt templates for `/api/identify` and `/api/analyze` are inline strings in `server.js` — adjust them directly
- Language/i18n: The frontend detects browser language and applies it to Claude's `remarks` field via the system prompt; there is no separate translation file
