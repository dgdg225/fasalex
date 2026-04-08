# CONTINUITY.md — FasalEx Session Log
## Persistent context for Claude Code across sessions

---

## SESSION: 2026-04-08

### Summary
Full audit, fix, and hardening session. App deployed to Railway (brave-success / farex-server) at www.fasalex.com.

### Changes Made

| Area | Change |
|------|--------|
| **Model** | All Claude API calls switched to `claude-haiku-4-5-20251001` (both `callClaude` and `callHaiku` in server.js) |
| **CLAUDE.md** | Created with full project rules: no Railway CLI, git push deploy only, Haiku model, CERT_SCALE=1, session log rules |
| **Railway** | Bound server to `0.0.0.0`, default port → 8080, added `railway.json` with healthcheck + restart policy |
| **farex-server removed** | Old `farex-server/` directory deleted from repo — fasalex is now the only app |
| **AI Detection** | Identify prompt made open-ended (any produce, not just hardcoded grains) |
| **Detection UI** | Animated confidence bar, description text, extended emoji map, fixed silent error |
| **Language** | Registration `r-lang` select now calls `setLang()` live; `verifyOTP` applies language; `applyLang` re-renders share + report pages |
| **DG Certificate** | Fixed `r.grade` → `r.overallGrade` in cert summary; added canvas/blob null checks; GPS null safety; download button wired |
| **Button fixes** | Removed dead `shareCertAsPNG` (used undefined `generateCertPNG`); fixed `showToast` → `toast`; fixed `sharePkg` → toast fallback |
| **Mobile fixes** | `sendAll()` uses `navigator.share` + single `window.open` (no setTimeout gesture-breaking loop); GPS `silent` flag prevents startup toast spam |

### Deployment State
- **Repo:** dgdg225/fasalex · branch: main
- **Latest commit:** 93dc233
- **Railway project:** brave-success · service: farex-server
- **URL:** www.fasalex.com
- **Auto-deploy:** on every push to main

### Known / Pending
- `exhibits.jsonl` lives at `/app/exhibits.jsonl` on Railway server — NOT in GitHub repo. Created automatically on first scan.
- Email/SMS share buttons (lines ~850, 873, 896) are placeholders showing `toast('Share failed')` — real email/SMS integration not yet built
- `downloadCertPDF` function name is misleading — it generates PNG not PDF
- `/api/prices` endpoint exists in server but frontend never calls it (market page uses static fallback data)

### Architecture Reminder
- `server.js` — pure Node.js HTTP server, no Express used despite being in package.json
- `public/index.html` — 3500+ line SPA, all state in global `S`, persisted to localStorage key `fx10`
- Two Claude API functions: `callClaude()` and `callHaiku()` — both now use Haiku model
- CERT_SCALE=1 (do not change)

---

*Log auto-updated per CLAUDE.md session rules.*
