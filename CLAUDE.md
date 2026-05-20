# Voice Invoice — Backend Project Instructions

_Last updated: 2026-05-20_

---

## Canonical Paths

| Location | Path |
|---|---|
| Project root | `/Users/macserver/Documents/Projects/Voice-Invoice` |
| Backend repo | `/Users/macserver/Documents/Projects/Voice-Invoice/voice-invoice-backend` |
| Frontend repo | `/Users/macserver/Documents/Projects/Voice-Invoice/voice-invoice-frontend` |

Do not create duplicate project copies in hidden Claude folders.
Do not silently move work outside the canonical paths.

---

## Deployment Overview

| Environment | URL | Notes |
|---|---|---|
| Production backend | `https://voice-invoice-backend-production.up.railway.app` | Railway, always on |
| Local backend | `http://localhost:5001` | Mac only, requires `node server.js` |
| Frontend (production) | `https://quotebox.net` (Netlify) | Parker's deployment target |
| Frontend (dev) | `http://localhost:5173` | Vite dev server |

The production backend is deployed on **Railway** via Docker (`Railway.toml` + `Dockerfile`).
To deploy: push to the connected GitHub branch — Railway redeploys automatically.

---

## Current Architecture

```
Frontend (Netlify / quotebox.net)
    │
    │  HTTPS
    ▼
Backend (Railway)
    │
    ├─ POST /api/parse-transcript  ──► Claude API (Anthropic)   ✅ works in production
    ├─ POST /api/quickbooks/dry-run ─► No external call          ✅ works in production
    ├─ POST /api/quickbooks/create-invoice ─► QuickBooks API     ✅ works if QBO tokens set
    │
    └─ POST /upload + /transcribe   ──► Whisper via SSH          ❌ DISABLED on Railway
       POST /api/transcribe-and-process ──► Whisper via SSH      ❌ DISABLED on Railway
```

### Transcription is disabled in the Railway deployment

`TRANSCRIPTION_PROVIDER` is set to `none` on Railway.
The SSH Whisper path (`linux_ssh`) only works on the local Mac dev machine, which has
SSH access to `linuxbox`. Railway has no such access.

When transcription is disabled:
- `POST /upload` still uploads audio to Supabase, but returns `transcript: null`.
- `POST /transcribe` returns an error.
- `POST /api/transcribe-and-process` returns HTTP 503 with `code: TRANSCRIPTION_DISABLED`
  and tells the caller to use `POST /api/parse-transcript` instead.

**The reliable production path right now is:**
```
User types or pastes a transcript
    → POST /api/parse-transcript   (Claude extracts invoice fields)
    → POST /api/quickbooks/dry-run (preview the QBO payload)
    → POST /api/quickbooks/create-invoice (create invoice in QBO — requires tokens)
```

The Voice tab (record audio → auto-transcribe → auto-extract) is **not production-ready**
until a cloud-safe transcription provider is added (e.g., OpenAI Whisper API).

---

## CORS

The backend currently allows all origins (`app.use(cors())`).
Before going live, restrict this to `https://quotebox.net` and `http://localhost:5173`.

---

## Auth

The backend does **not** enforce JWT authentication on most endpoints today.
`POST /api/transcribe-and-process` forwards the `Authorization: Bearer <token>` header
into Supabase so Row Level Security policies apply, but it also trusts `user_id` from
the request body.

This is a development shortcut. Before production:
- Verify the JWT server-side and extract `user_id` from it.
- Do not trust `user_id` from the request body.

---

## Environment Variables

Never commit secrets. See `.env.example` for a full template.

Key variables the Railway deployment needs:

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key (public) |
| `ANTHROPIC_API_KEY` | Claude API key for invoice parsing |
| `TRANSCRIPTION_PROVIDER` | Set to `none` on Railway |
| `INTUIT_CLIENT_ID` | QuickBooks OAuth client ID |
| `INTUIT_CLIENT_SECRET` | QuickBooks OAuth client secret |
| `INTUIT_REDIRECT_URI` | Must match Intuit app settings |
| `INTUIT_ENVIRONMENT` | `sandbox` or `production` |
| `QBO_REALM_ID` | Company ID from OAuth callback |
| `QBO_ACCESS_TOKEN` | OAuth access token (~1 hour TTL) |
| `QBO_REFRESH_TOKEN` | OAuth refresh token (~100 days TTL) |

Set these in Railway → your service → Variables. Never put them in code.

---

## Services

| File | What it does |
|---|---|
| `server.js` | Express app, all route definitions |
| `services/invoiceParser.js` | Sends transcript to Claude API, returns structured invoice JSON |
| `services/quickbooksService.js` | QBO OAuth helpers + invoice payload builder + create-invoice call |

The transcription service is in `services/transcription/transcriber.js` (loaded dynamically).
On Railway it resolves to a no-op / disabled stub.

---

## What Works in Production (Railway)

| Endpoint | Status |
|---|---|
| `GET /health` | ✅ Always works — use to verify deployment |
| `GET /` | ✅ Alive check |
| `POST /api/parse-transcript` | ✅ Claude extraction from text transcript |
| `POST /api/quickbooks/dry-run` | ✅ Preview QBO payload (no tokens needed) |
| `GET /api/quickbooks/connect` | ✅ Returns OAuth URL (requires INTUIT vars) |
| `GET /api/quickbooks/callback` | ✅ Exchanges code for tokens |
| `POST /api/quickbooks/create-invoice` | ✅ Creates real invoice (requires QBO tokens) |
| `POST /upload` | ⚠️ Upload succeeds, transcription returns null |
| `POST /transcribe` | ❌ Disabled — transcription provider is `none` |
| `POST /api/transcribe-and-process` | ❌ Returns 503 TRANSCRIPTION_DISABLED |

---

## Working Style for AI Agents

- Re-read actual files before making claims about them.
- Make small, targeted edits only.
- Do not refactor broadly unless necessary.
- Do not push to GitHub automatically — show the diff first.
- Never include secrets, `.env` values, or tokens in documentation.
- If a bug is found, fix the smallest thing that solves it.
- Keep explanations beginner-friendly.

---

## Notes on Future Work

- **Cloud transcription**: Add `TRANSCRIPTION_PROVIDER=openai_whisper` path to enable
  the Voice tab in production without SSH dependency.
- **QBO token refresh**: `refreshAccessToken()` exists in `quickbooksService.js` but is
  not called automatically. Access tokens expire in ~1 hour. Wire auto-refresh before launch.
- **Auth hardening**: Verify JWT server-side before trusting any user identity claim.
- **CORS lockdown**: Restrict allowed origins to production domains before launch.
