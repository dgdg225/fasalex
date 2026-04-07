# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

The server starts on port 3000 (override with `PORT` env var). Access from phone on same WiFi via `http://<local-ip>:3000`.

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

- **Claude model used:** `claude-sonnet-4-20250514` with 40-second timeout
- **AGMARK grading data** is hardcoded in `server.js` (object `AGMARK_SRV`, ~lines 284–303) for 20+ commodities
- **Static price fallbacks** are hardcoded in `server.js` (`STATIC_FALLBACK`, ~lines 310–330) for when external APIs are unavailable
- **K-calibration:** Patent-pending formula `K = D_known/D_px` for size measurement using reference objects (credit card, SIM packet, ruler, etc.)
- **Price cache** is written to `price_cache.json` at runtime and auto-refreshed daily at 06:00 IST
- **GPS fallback** is Hospet, Karnataka (15.2624°N, 76.3823°E)
- Images are base64-encoded and sent directly to the Claude API; no file storage
- Certificate generation uses the Canvas API and downloads as PNG

## Adding or Changing Features

- All frontend page logic, CSS, and HTML live in `public/index.html` — search by page ID (e.g., `id="page-scan"`) or function name
- To add a new commodity to grading, update `AGMARK_SRV` and `STATIC_FALLBACK` in `server.js`
- The Claude prompt templates for `/api/identify` and `/api/analyze` are inline strings in `server.js` — adjust them directly
- Language/i18n: The frontend detects browser language and applies it to Claude's `remarks` field via the system prompt; there is no separate translation file
