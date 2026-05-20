# Voice Invoice — API Reference

_For frontend developers wiring the UI to the Railway backend._
_Last updated: 2026-05-20_

---

## Base URL

```
Production (Railway):  https://voice-invoice-backend-production.up.railway.app
Local dev (Mac only):  http://localhost:5001
```

**The frontend should point at Railway for any deployed / shared testing.**
`http://localhost:5001` only works if the backend is also running on your Mac.

Set the base URL in your frontend environment config, e.g.:
```
VITE_API_URL=https://voice-invoice-backend-production.up.railway.app
```

---

## Headers

Most endpoints only require:

```
Content-Type: application/json
```

The one exception is `POST /api/transcribe-and-process`, which also requires:

```
Authorization: Bearer <supabase_access_token>
```

There is **no global API key** required from the frontend side. The backend
reads its own secret keys from environment variables on Railway.

---

## CORS

The backend currently allows all origins. You do not need to add special CORS headers
from the frontend. This will be locked down to `https://quotebox.net` before launch.

---

## What Works vs. What Doesn't

| Feature | Status | Endpoint to call |
|---|---|---|
| Check backend is alive | ✅ Working | `GET /health` |
| Parse a text transcript → invoice JSON | ✅ Working | `POST /api/parse-transcript` |
| Preview a QuickBooks invoice payload | ✅ Working | `POST /api/quickbooks/dry-run` |
| Start QuickBooks OAuth flow | ✅ Working | `GET /api/quickbooks/connect` |
| Create a real QuickBooks invoice | ✅ Working (needs QBO tokens) | `POST /api/quickbooks/create-invoice` |
| Record audio → auto-transcribe → invoice | ❌ Not production-ready | — |

The Voice tab (audio → Whisper → Claude) **is not available on Railway**.
Transcription requires SSH access to a Linux box that only exists on the local Mac.
Until a cloud-safe transcription provider is added, the Voice tab should be hidden
or show a "coming soon" message in the deployed frontend.

**The reliable demo path is:**
1. User types or pastes what they want on the invoice (as if reading their notes aloud).
2. Frontend sends that text to `POST /api/parse-transcript`.
3. Backend returns structured invoice JSON.
4. Frontend displays the invoice for review/editing.
5. Frontend calls `POST /api/quickbooks/dry-run` to preview, or `create-invoice` to push.

---

## Endpoints

---

### GET /health

Check that the backend is alive and see what features are enabled.

**No request body. No headers required.**

**Response (200):**
```json
{
  "status": "ok",
  "service": "voice-invoice-backend",
  "port": 5001,
  "environment": "production",
  "transcription_provider": "disabled",
  "voice_transcription_available": false,
  "claude_configured": true,
  "quickbooks_configured": true,
  "timestamp": "2026-05-20T12:00:00.000Z"
}
```

`voice_transcription_available: false` means the Voice tab will not work in this
deployment. That is expected on Railway.

---

### GET /

Minimal alive check. Returns a short JSON message and the transcription provider name.

**Response (200):**
```json
{
  "message": "Voice Invoice API - alive",
  "provider": "disabled"
}
```

---

### POST /api/parse-transcript   ← Primary demo endpoint

Send a plain-text transcript. Claude extracts client info and line items and returns
structured invoice JSON. No audio required. No Whisper. Works on Railway.

**Request:**
```http
POST /api/parse-transcript
Content-Type: application/json

{
  "transcript": "Invoice for John Smith at 123 Main Street. We replaced the kitchen faucet. Labor two hours at 95 dollars an hour. Faucet part 120 dollars."
}
```

**`transcript`** — required string. Any natural language description of the job.
Aim for at least one sentence. Claude handles incomplete or messy input gracefully.

**Response — success (200):**
```json
{
  "success": true,
  "transcript": "Invoice for John Smith...",
  "invoice": {
    "client_name": "John Smith",
    "client_company": null,
    "client_phone": null,
    "client_email": null,
    "client_address": "123 Main Street",
    "job_location": null,
    "job_description": "Kitchen faucet replacement",
    "job_reference_number": null,
    "notes": null,
    "line_items": [
      {
        "service_name": "Labor",
        "description": "Kitchen faucet replacement labor",
        "category": "labor",
        "quantity": 2,
        "unit": "hr",
        "unit_price": 95,
        "is_taxable": true
      },
      {
        "service_name": "Faucet part",
        "description": "Kitchen faucet replacement part",
        "category": "materials",
        "quantity": 1,
        "unit": "ea",
        "unit_price": 120,
        "is_taxable": false
      }
    ]
  }
}
```

**`invoice` field notes:**
- Any field not mentioned in the transcript is `null`.
- `line_items` is always an array; may be empty if nothing specific was said.
- `category` is one of: `labor`, `materials`, `equipment`, `subcontractor`, `other`.
- `unit` is one of: `ea`, `hr`, `sqft`, `lf`, `day`, `lot`.
- `unit_price` is a number. `0` means the price wasn't mentioned.
- `is_taxable`: `true` for labor/services, `false` for materials (Claude decides).

**Response — error (400):**
```json
{
  "success": false,
  "error": "transcript is required"
}
```

**Response — Claude API error (500):**
```json
{
  "success": false,
  "error": "Claude API error: ..."
}
```

---

### POST /api/quickbooks/dry-run

Takes an invoice object (or a Supabase `draft_id`) and returns the formatted
QuickBooks Online invoice payload **without creating anything in QBO**.

Use this to preview what QBO would receive, or to test the mapping before
QBO credentials are set up.

**Request — pass invoice directly:**
```http
POST /api/quickbooks/dry-run
Content-Type: application/json

{
  "invoice": {
    "client_name": "John Smith",
    "client_email": "john@example.com",
    "client_address": "123 Main Street",
    "job_description": "Kitchen faucet replacement",
    "notes": null,
    "line_items": [
      {
        "service_name": "Labor",
        "description": "Replaced kitchen faucet",
        "quantity": 2,
        "unit_price": 95
      }
    ]
  }
}
```

**Request — pass a Supabase draft ID instead:**
```json
{
  "draft_id": "uuid-of-the-invoice-draft"
}
```

Either `invoice` or `draft_id` is required. If both are given, `invoice` is used.

**Response — success (200):**
```json
{
  "success": true,
  "dry_run": true,
  "qbo_configured": true,
  "qbo_connected": false,
  "message": "QBO not connected — this is what the invoice payload would look like",
  "qbo_invoice_payload": {
    "Line": [
      {
        "Amount": 190,
        "DetailType": "SalesItemLineDetail",
        "Description": "Labor — Replaced kitchen faucet",
        "SalesItemLineDetail": {
          "ItemRef": { "value": "1", "name": "Labor" },
          "Qty": 2,
          "UnitPrice": 95
        }
      }
    ],
    "CustomerRef": { "value": "1", "name": "John Smith" },
    "BillEmail": { "Address": "john@example.com" },
    "BillAddr": { "Line1": "123 Main Street" },
    "CustomerMemo": { "value": "Kitchen faucet replacement" }
  }
}
```

`qbo_connected: true` means QBO tokens are present and `/create-invoice` will work.
`qbo_connected: false` means tokens are missing — dry-run still works fine.

---

### GET /api/quickbooks/connect

Returns the Intuit OAuth URL the user must visit to connect their QuickBooks company.

**No request body. No headers required.**

**Response — success (200):**
```json
{
  "success": true,
  "auth_url": "https://appcenter.intuit.com/connect/oauth2?client_id=...&redirect_uri=..."
}
```

**Response — not configured (503):**
```json
{
  "success": false,
  "error": "QuickBooks not configured — INTUIT_CLIENT_ID / INTUIT_CLIENT_SECRET / INTUIT_REDIRECT_URI missing from .env",
  "missing_vars": ["INTUIT_CLIENT_ID"]
}
```

**Frontend flow:**
1. Call `GET /api/quickbooks/connect` to get `auth_url`.
2. Redirect the user to `auth_url` (Intuit login page).
3. After the user approves, Intuit redirects to the callback URL configured in
   the Intuit Developer Portal. The backend handles this automatically.
4. After the callback, tokens are displayed and must be saved to Railway Variables.

**Important:** The `INTUIT_REDIRECT_URI` in the Railway environment variables must
exactly match one of the URIs registered in the Intuit Developer Portal.
For production it should be something like:
```
https://voice-invoice-backend-production.up.railway.app/api/quickbooks/callback
```

---

### GET /api/quickbooks/callback

Intuit calls this automatically after the user completes OAuth. The backend
exchanges the auth code for tokens and displays them in the browser.

**This endpoint is for Intuit to call, not for the frontend to call directly.**

After visiting it, the browser shows the `QBO_REALM_ID`, `QBO_ACCESS_TOKEN`, and
`QBO_REFRESH_TOKEN` that need to be saved in Railway → Variables.

---

### POST /api/quickbooks/create-invoice

Creates a real invoice in QuickBooks Online.

Requires `QBO_ACCESS_TOKEN` and `QBO_REALM_ID` to be set in Railway Variables.
Access tokens expire in approximately 1 hour. If the token is expired, you must
re-run the OAuth flow (`GET /api/quickbooks/connect`) to get a fresh one.

**Request — pass invoice directly:**
```http
POST /api/quickbooks/create-invoice
Content-Type: application/json

{
  "invoice": {
    "client_name": "John Smith",
    "client_email": "john@example.com",
    "client_address": "123 Main Street",
    "job_description": "Kitchen faucet replacement",
    "notes": null,
    "line_items": [
      {
        "service_name": "Labor",
        "description": "Replaced kitchen faucet",
        "quantity": 2,
        "unit_price": 95
      }
    ]
  }
}
```

**Request — pass a Supabase draft ID instead:**
```json
{
  "draft_id": "uuid-of-the-invoice-draft"
}
```

**Response — success (200):**
```json
{
  "success": true,
  "qbo_invoice_id": "123",
  "qbo_invoice_num": "1001",
  "total": 190.00,
  "status": "NotSet",
  "view_url": "https://app.sandbox.qbo.intuit.com/app/invoice?txnId=123"
}
```

**Response — not connected (503):**
```json
{
  "success": false,
  "error": "QuickBooks not connected",
  "message": "Missing one or more of: QBO_ACCESS_TOKEN, QBO_REALM_ID, INTUIT_CLIENT_ID, INTUIT_CLIENT_SECRET",
  "missing_vars": ["QBO_ACCESS_TOKEN"],
  "next_step": "Visit GET /api/quickbooks/connect to get the OAuth URL, complete the flow, and paste the tokens into .env"
}
```

**Response — expired token (401):**
```json
{
  "success": false,
  "error": "...",
  "hint": "Access token expired — use QBO_REFRESH_TOKEN to get a new one, or reconnect via /api/quickbooks/connect"
}
```

---

### POST /api/transcribe-and-process   ❌ Disabled on Railway

This is the Voice tab endpoint. It transcribes audio via Whisper over SSH, then
runs Claude extraction, then saves to Supabase.

**This endpoint returns 503 on Railway** because the SSH Whisper path is only
available on the local Mac dev machine.

**Response on Railway (503):**
```json
{
  "success": false,
  "error": "Audio transcription is not available in this deployment.",
  "message": "Voice transcription is disabled in cloud/demo mode. Send a text transcript to POST /api/parse-transcript instead.",
  "demo_route": "POST /api/parse-transcript",
  "code": "TRANSCRIPTION_DISABLED"
}
```

When the frontend calls this endpoint and gets `TRANSCRIPTION_DISABLED`, it should
prompt the user to type their notes instead, and route to `POST /api/parse-transcript`.

**When it does work (local dev with `TRANSCRIPTION_PROVIDER=linux_ssh`):**

```http
POST /api/transcribe-and-process
Authorization: Bearer <supabase_access_token>
Content-Type: application/json

{
  "audio_file_url": "user-uuid/1716220800000.webm",
  "user_id": "user-uuid"
}
```

`audio_file_url` is the path within the `audio-recordings` Supabase bucket, not
a full URL. The backend builds the full public URL internally.

**Response — success (200):**
```json
{
  "success": true,
  "draft_id": "uuid-of-saved-draft",
  "transcript": "Raw transcript text from Whisper...",
  "invoice": { ... }
}
```

---

### POST /upload   ⚠️ Partial on Railway

Accepts a multipart audio file upload, stores it in the `invoice_audio` Supabase
bucket, and attempts transcription.

On Railway, the upload to Supabase succeeds, but transcription returns `null`
because the transcription provider is `disabled`.

**Request:**
```
Content-Type: multipart/form-data
Body: form field named "file" containing an audio file (max 25 MB)
Accepted MIME types: audio/*
```

**Response — upload succeeded, transcription skipped (200):**
```json
{
  "success": true,
  "fileName": "audio_1716220800000.webm",
  "audioFileUrl": "https://czlehwhhehplkaprbqcm.supabase.co/storage/v1/object/public/invoice_audio/uploads/audio_1716220800000.webm",
  "transcript": null,
  "message": "Audio uploaded but transcription failed",
  "transcriptionError": "...",
  "code": "TRANSCRIPTION_ERROR",
  "provider": "disabled"
}
```

---

### POST /transcribe   ❌ Disabled on Railway

Takes a public audio URL and attempts to transcribe it. Returns an error on Railway
because the transcription provider is `disabled`.

---

## Error Shape

All errors follow this shape:

```json
{
  "success": false,
  "error": "Human-readable error message",
  "code": "MACHINE_READABLE_CODE"   // present on some errors
}
```

Common codes:

| Code | Meaning |
|---|---|
| `TRANSCRIPTION_DISABLED` | Whisper SSH not available in this deployment |
| `TRANSCRIPTION_ERROR` | Transcription attempted but failed |
| `NO_FILE` | File upload had no file attached |
| `NO_AUDIO_URL` | `/transcribe` called without `audioFileUrl` |
| `STORAGE_ERROR` | Supabase storage write failed |

---

## Quick Start for Parker

1. **Verify the backend is alive:**
   ```
   GET https://voice-invoice-backend-production.up.railway.app/health
   ```
   Confirm `claude_configured: true` and `quickbooks_configured: true`.

2. **Test invoice extraction:**
   ```http
   POST https://voice-invoice-backend-production.up.railway.app/api/parse-transcript
   Content-Type: application/json

   { "transcript": "Invoice for Jane Doe, 5 hours electrical work at 110 per hour, plus 200 in materials." }
   ```

3. **Preview the QBO payload:**
   Take the `invoice` object from step 2 and POST it to:
   ```
   POST /api/quickbooks/dry-run
   Body: { "invoice": <invoice object from above> }
   ```

4. **Wire the QuickBooks OAuth (one-time setup):**
   - Visit `GET /api/quickbooks/connect` to get the auth URL.
   - Complete the Intuit OAuth flow.
   - Save the returned tokens as Railway Variables.
   - Then `POST /api/quickbooks/create-invoice` will work.
