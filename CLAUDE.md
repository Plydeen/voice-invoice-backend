# Voice Invoice — Project Instructions

## Canonical Paths
- Project root: `/Users/macserver/Documents/Projects/Voice-Invoice`
- Backend repo: `/Users/macserver/Documents/Projects/Voice-Invoice/voice-invoice-backend`
- Frontend repo: `/Users/macserver/Documents/Projects/Voice-Invoice/voice-invoice-frontend`

Do not create duplicate project copies in hidden Claude folders.
Do not silently move work outside the canonical paths.

## Architecture
Keep this architecture unless explicitly told otherwise:

Mac backend -> SSH -> Linux box Whisper

Do not re-open the transcription architecture debate.
Do not switch Stage 2 back to Railway-hosted Whisper.
Do not switch transcription to OpenAI Whisper for current development.

## Current Project State
- Stage 2 is complete
- `/upload` works end to end
- `/transcribe` works end to end
- Stage 3 is partially implemented but not fully verified

## Parker Decisions
- Extraction should happen automatically right after recording
- User should speak, stop, wait briefly, and receive a finished invoice draft
- Frontend still allows editing afterward
- First populated fields should be line items with descriptions, plus a main description
- Use Claude API for extraction
- Target is a demoable result before May 18

## Known Frontend Contract
- Frontend calls `POST /api/transcribe-and-process`
- Request body: `{ audio_file_url, user_id }`
- Header: `Authorization: Bearer <supabase access token>`
- Audio bucket: `audio-recordings`
- Audio path format: `user_id/timestamp.webm` or `.mp4`
- Frontend dev API base URL: `http://localhost:5001`

## Auth Note
Current Stage 3 dev behavior:
- Backend forwards Bearer token into Supabase calls
- This may allow RLS to work correctly
- Backend still temporarily trusts `user_id` from request body

Treat that as a development shortcut.
Do not present it as final production auth.
Prefer minimal changes until Stage 3 is verified.

## Working Style
- Re-read actual files before making claims
- Make small targeted changes only
- Do not refactor broadly unless necessary
- If a bug is found, fix the smallest thing that solves it
- Prefer verification over more implementation
- Keep explanations concise and beginner-friendly

## Stage 3 Priority
Focus on verification in this order:
1. Verify SSH to `linuxbox`
2. Verify backend `/api/transcribe-and-process` with real values
3. Verify Claude parsing
4. Verify writes to `invoice_drafts` and `line_items`
5. Verify frontend `VoiceRecorder` flow

Do not call Stage 3 complete until both:
- backend endpoint works with real values
- frontend flow works end to end

## Environment Expectations
Backend expects:
- local Node server
- working SSH to `linuxbox`
- Linux whisper venv
- valid `ANTHROPIC_API_KEY`
- Supabase access via environment variables

Frontend expects:
- valid Supabase auth session
- `VITE_API_URL=http://localhost:5001`

## Notes
When a major implementation or behavior change is confirmed, update this `CLAUDE.md` so future sessions start from the current truth.