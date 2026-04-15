# CONTINUITY.md — FasalEx Session Log
## Persistent context for Claude Code across sessions

---

## SESSION: 2026-04-08
**Started:** 2026-04-08 (morning IST)
**Closed:** 2026-04-08 21:48 IST
**Last commit:** e2c0a06 · pushed to dgdg225/fasalex main

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
- **Latest commit:** e2c0a06 (2026-04-08 21:48 IST)
- **Railway project:** brave-success · service: farex-server
- **URL:** www.fasalex.com
- **Auto-deploy:** on every push to main

### Known / Pending
- `exhibits.jsonl` lives at `/app/exhibits.jsonl` on Railway server — NOT in GitHub repo. Created automatically on first scan.
- Email/SMS share buttons (lines ~850, 873, 896) are placeholders showing `toast('Share failed')` — real email/SMS integration not yet built
- `downloadCertPDF` function name is misleading — it generates PNG not PDF
- `/api/prices` endpoint exists in server but frontend never calls it (market page uses static fallback data)

### Architecture Reminder
- `server.js` — Express server (273 lines), uses `@anthropic-ai/sdk`, both endpoints use Haiku
- `public/index.html` — 3500+ line SPA, all state in global `S`, persisted to localStorage key `fx10`
- CERT_SCALE=1 (do not change)

---

*Log last updated: 2026-04-15 12:35 IST · commit: db67f69
