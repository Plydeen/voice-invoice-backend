require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5001;

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Set up multer to handle file uploads (max 25MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  }
});

app.use(cors());
app.use(express.json());

// Get transcription provider from environment
const { transcribeAudio: transcribeAudioProvider } = require('./services/transcription/transcriber');
const TRANSCRIPTION_PROVIDER = process.env.TRANSCRIPTION_PROVIDER || 'none';

// Invoice parser (uses Claude API)
const { parseInvoiceFromTranscript } = require('./services/invoiceParser');

console.log(`Using transcription provider: ${TRANSCRIPTION_PROVIDER}`);

// ============= HEALTH CHECK =============

app.get('/', (req, res) => {
  res.json({ message: 'Voice Invoice API - alive', provider: TRANSCRIPTION_PROVIDER });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'voice-invoice-backend',
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    transcription_provider: TRANSCRIPTION_PROVIDER,
    voice_transcription_available: TRANSCRIPTION_PROVIDER === 'linux_ssh',
    claude_configured: !!process.env.ANTHROPIC_API_KEY,
    quickbooks_configured: !!(process.env.INTUIT_CLIENT_ID && process.env.INTUIT_CLIENT_SECRET),
    timestamp: new Date().toISOString()
  });
});

// ============= STEP 1 & 2: AUDIO UPLOAD + TRANSCRIPTION =============

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file provided',
        code: 'NO_FILE'
      });
    }

    const timestamp = Date.now();
    const fileName = `audio_${timestamp}.${req.file.originalname.split('.').pop()}`;

    // Step 1: Upload audio to Supabase storage
    const { data, error: uploadError } = await supabase.storage
      .from('invoice_audio')
      .upload(`uploads/${fileName}`, req.file.buffer, {
        contentType: req.file.mimetype
      });

    if (uploadError) {
      console.error('Storage error:', uploadError);
      return res.status(500).json({
        success: false,
        error: 'Failed to upload file to storage',
        code: 'STORAGE_ERROR'
      });
    }

    const { data: publicUrlData } = supabase.storage
      .from('invoice_audio')
      .getPublicUrl(`uploads/${fileName}`);

    const audioFileUrl = publicUrlData.publicUrl;

    console.log('Upload successful, starting transcription...');

    // Step 2: Transcribe using configured provider (Linux SSH for development)
    const transcriptionResult = await transcribeAudioProvider(req.file.buffer, audioFileUrl);

    if (transcriptionResult.success) {
      console.log('Transcription successful!');
      res.json({
        success: true,
        fileName: fileName,
        audioFileUrl: audioFileUrl,
        transcript: transcriptionResult.transcript,
        message: 'Audio uploaded and transcribed successfully',
        provider: TRANSCRIPTION_PROVIDER
      });
    } else {
      console.log(`Transcription failed: ${transcriptionResult.error}`);
      res.status(200).json({
        success: true,         // Upload succeeded, transcription failed
        fileName: fileName,
        audioFileUrl: audioFileUrl,
        transcript: null,
        message: 'Audio uploaded but transcription failed',
        transcriptionError: transcriptionResult.error,
        code: 'TRANSCRIPTION_ERROR',
        provider: TRANSCRIPTION_PROVIDER
      });
    }

  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'UPLOAD_ERROR'
    });
  }
});

// ============= STEP 2 SEPARATE ENDPOINT (for testing) =============

app.post('/transcribe', async (req, res) => {
  try {
    const { audioFileUrl } = req.body;

    if (!audioFileUrl) {
      return res.status(400).json({
        success: false,
        error: 'audioFileUrl is required',
        code: 'NO_AUDIO_URL'
      });
    }

    console.log('Transcribing audio from:', audioFileUrl);

    // Get a test audio buffer (for testing via /transcribe endpoint)
    const audioResponse = await axios.get(audioFileUrl, { responseType: 'arraybuffer' });

    const transcriptionResult = await transcribeAudioProvider(audioResponse.data, audioFileUrl);

    if (transcriptionResult.success) {
      res.json({
        success: true,
        transcript: transcriptionResult.transcript,
        message: 'Audio transcribed successfully',
        provider: TRANSCRIPTION_PROVIDER
      });
    } else {
      res.status(200).json({
        success: false,
        transcript: null,
        message: 'Transcription failed',
        error: transcriptionResult.error,
        code: 'TRANSCRIPTION_ERROR',
        provider: TRANSCRIPTION_PROVIDER
      });
    }

  } catch (err) {
    console.error('Transcribe error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'TRANSCRIBE_ERROR'
    });
  }
});

// ============= DEMO FALLBACK: PARSE TRANSCRIPT DIRECTLY =============
//
// Accepts a raw text transcript and returns structured invoice JSON via Claude.
// No audio, no SSH, no Whisper needed — perfect for demos and testing.
//
// POST /api/parse-transcript
// Body: { transcript: "Create an invoice for John Smith..." }
// Returns: { success: true, invoice: { client_name, line_items, ... } }

app.post('/api/parse-transcript', async (req, res) => {
  try {
    const { transcript } = req.body;

    if (!transcript || transcript.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'transcript is required'
      });
    }

    console.log(`[parse-transcript] Parsing ${transcript.length} chars via Claude...`);

    const parseResult = await parseInvoiceFromTranscript(transcript);

    if (!parseResult.success) {
      return res.status(500).json({
        success: false,
        error: parseResult.error,
        transcript
      });
    }

    console.log(`[parse-transcript] Done. Line items: ${parseResult.invoice.line_items.length}`);

    res.json({
      success: true,
      transcript,
      invoice: parseResult.invoice
    });

  } catch (err) {
    console.error('[parse-transcript] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============= STAGE 3: TRANSCRIBE + PARSE + SAVE =============
//
// This is the main endpoint the frontend calls after uploading audio to Supabase.
// It does three things in sequence:
//   1. Transcribe the audio via SSH Whisper on the Linux box
//   2. Parse the transcript into invoice fields using Claude API
//   3. Save the draft and line items to Supabase, then return the result
//
// The frontend sends:
//   POST /api/transcribe-and-process
//   Authorization: Bearer <supabase_access_token>
//   Body: { audio_file_url: "user-id/timestamp.webm", user_id: "uuid" }

app.post('/api/transcribe-and-process', async (req, res) => {
  try {
    const { audio_file_url, user_id } = req.body;
    const authHeader = req.headers.authorization;

    if (!audio_file_url || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'audio_file_url and user_id are required'
      });
    }

    // Guard: if audio transcription is disabled (cloud/Railway mode), fail fast
    // with a clear message instead of crashing or trying to SSH.
    if (TRANSCRIPTION_PROVIDER !== 'linux_ssh') {
      return res.status(503).json({
        success: false,
        error: 'Audio transcription is not available in this deployment.',
        message:
          'Voice transcription is disabled in cloud/demo mode. ' +
          'Send a text transcript to POST /api/parse-transcript instead.',
        demo_route: 'POST /api/parse-transcript',
        code: 'TRANSCRIPTION_DISABLED'
      });
    }

    // Detect the file extension from the path (e.g. "user-id/1234567890.webm" → "webm").
    // Whisper needs the correct extension to know the audio format.
    const ext = audio_file_url.split('.').pop() || 'webm';

    // Build the full public URL for the audio-recordings bucket.
    // The frontend uploads directly to this bucket, so we read from it here.
    const audioPublicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/audio-recordings/${audio_file_url}`;

    console.log(`[transcribe-and-process] Starting for user: ${user_id}`);
    console.log(`[transcribe-and-process] Audio: ${audioPublicUrl} (ext: ${ext})`);

    // ── Step 1: Transcribe via SSH Whisper ───────────────────────────────────
    const transcriptionResult = await transcribeAudioProvider(null, audioPublicUrl, ext);

    if (!transcriptionResult.success) {
      console.error('[transcribe-and-process] Transcription failed:', transcriptionResult.error);
      return res.status(500).json({
        success: false,
        error: 'Transcription failed: ' + transcriptionResult.error
      });
    }

    const { transcript } = transcriptionResult;
    console.log(`[transcribe-and-process] Transcription done. ${transcript.length} characters.`);

    // ── Step 2: Parse invoice fields using Claude API ────────────────────────
    const parseResult = await parseInvoiceFromTranscript(transcript);

    if (!parseResult.success) {
      // Transcription worked but Claude parsing failed.
      // Return the transcript anyway so the user isn't left with nothing.
      console.error('[transcribe-and-process] Parsing failed:', parseResult.error);
      return res.status(500).json({
        success: false,
        error: 'Invoice parsing failed: ' + parseResult.error,
        transcript
      });
    }

    const { invoice } = parseResult;
    console.log(`[transcribe-and-process] Parsing done. Line items: ${invoice.line_items.length}`);

    // ── Step 3: Save to Supabase ─────────────────────────────────────────────
    //
    // We create a Supabase client that acts as the logged-in user by forwarding
    // their Bearer token. This makes RLS policies work correctly — rows are
    // owned by the right user_id automatically.
    //
    // TODO (before production): switch to service role key for backend writes,
    // and verify the JWT to extract user_id instead of trusting the request body.
    const userSupabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      {
        global: {
          headers: { Authorization: authHeader || '' }
        }
      }
    );

    // Insert the invoice draft row
    const { data: draft, error: draftError } = await userSupabase
      .from('invoice_drafts')
      .insert({
        user_id,
        transcript,
        audio_file_urls: [audio_file_url],
        status: 'draft',
        client_name: invoice.client_name || null,
        client_company: invoice.client_company || null,
        client_phone: invoice.client_phone || null,
        client_email: invoice.client_email || null,
        client_address: invoice.client_address || null,
        job_location: invoice.job_location || null,
        job_description: invoice.job_description || null,
        job_reference_number: invoice.job_reference_number || null,
        notes: invoice.notes || null,
      })
      .select()
      .single();

    if (draftError) {
      console.error('[transcribe-and-process] Failed to save draft:', draftError.message);
      // Return the parsed data even if DB save fails — user can still see the result
      return res.status(500).json({
        success: false,
        error: 'Failed to save invoice draft: ' + draftError.message,
        transcript,
        invoice
      });
    }

    console.log(`[transcribe-and-process] Draft saved: ${draft.id}`);

    // Insert line items (if any were extracted)
    if (invoice.line_items && invoice.line_items.length > 0) {
      const lineItemRows = invoice.line_items.map((item, index) => ({
        draft_id: draft.id,
        service_name: item.service_name,
        description: item.description || null,
        category: item.category || 'other',
        quantity: typeof item.quantity === 'number' ? item.quantity : 1,
        unit: item.unit || 'ea',
        unit_price: typeof item.unit_price === 'number' ? item.unit_price : 0,
        is_taxable: item.is_taxable !== false,  // default to taxable
        line_order: index
      }));

      const { error: lineItemError } = await userSupabase
        .from('line_items')
        .insert(lineItemRows);

      if (lineItemError) {
        // Log but don't fail — the draft is saved, line items can be added manually
        console.error('[transcribe-and-process] Failed to save line items:', lineItemError.message);
      } else {
        console.log(`[transcribe-and-process] ${lineItemRows.length} line items saved.`);
      }
    }

    // ── Done: return everything the frontend needs ────────────────────────────
    res.json({
      success: true,
      draft_id: draft.id,
      transcript,
      invoice
    });

  } catch (err) {
    console.error('[transcribe-and-process] Unexpected error:', err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ============= QUICKBOOKS INTEGRATION =============

const {
  buildAuthUrl,
  exchangeCodeForTokens,
  buildQBOInvoicePayload,
  createQBOInvoice,
  isQBOConfigured,
  isQBOConnected
} = require('./services/quickbooksService');

// GET /api/quickbooks/connect
// Returns the Intuit OAuth URL the frontend should redirect the user to.
app.get('/api/quickbooks/connect', (req, res) => {
  try {
    if (!isQBOConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'QuickBooks not configured — INTUIT_CLIENT_ID / INTUIT_CLIENT_SECRET / INTUIT_REDIRECT_URI missing from .env',
        missing_vars: ['INTUIT_CLIENT_ID', 'INTUIT_CLIENT_SECRET', 'INTUIT_REDIRECT_URI'].filter(v => !process.env[v])
      });
    }
    const auth_url = buildAuthUrl();
    res.json({ success: true, auth_url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/quickbooks/callback
// Intuit redirects here after the user approves. Exchanges code for tokens.
// In production: save tokens to DB. For demo: print them so you can set them in .env.
app.get('/api/quickbooks/callback', async (req, res) => {
  try {
    const { code, realmId, state, error: oauthError } = req.query;

    if (oauthError) {
      return res.status(400).send(`<h1>QuickBooks Authorization Failed</h1><p>${oauthError}</p>`);
    }

    if (!code || !realmId) {
      return res.status(400).send('<h1>Missing code or realmId in callback</h1>');
    }

    console.log('[qb-callback] Exchanging code for tokens, realmId:', realmId);
    const tokens = await exchangeCodeForTokens(code, realmId);

    console.log('[qb-callback] Got tokens! access_token starts with:', tokens.access_token.slice(0, 20));
    console.log('[qb-callback] realm_id:', realmId);

    // For the demo: show tokens in browser so they can be pasted into .env
    // In production: save to database and set a session/cookie
    res.send(`
      <html><body style="font-family:monospace;padding:2em;background:#f5f5f5">
        <h2 style="color:green">✅ QuickBooks Connected!</h2>
        <p>Add these to your <code>voice-invoice-backend/.env</code> file:</p>
        <pre style="background:#fff;padding:1em;border:1px solid #ccc;border-radius:4px">
QBO_REALM_ID=${tokens.realm_id}
QBO_ACCESS_TOKEN=${tokens.access_token}
QBO_REFRESH_TOKEN=${tokens.refresh_token}
        </pre>
        <p>Then restart the backend: <code>node server.js</code></p>
        <p><a href="http://localhost:5173">← Back to Voice Invoice</a></p>
      </body></html>
    `);
  } catch (err) {
    console.error('[qb-callback] Error:', err.message);
    res.status(500).send(`<h1>Callback Error</h1><pre>${err.message}</pre>`);
  }
});

// POST /api/quickbooks/dry-run
// Takes an invoice JSON (or a draft_id) and returns the QBO-ready payload
// WITHOUT actually creating anything. Perfect for demo if tokens aren't set yet.
// Body: { invoice: { client_name, line_items, ... } }
app.post('/api/quickbooks/dry-run', async (req, res) => {
  try {
    const { invoice, draft_id } = req.body;

    let invoiceData = invoice;

    // If draft_id was given, fetch from Supabase
    if (!invoiceData && draft_id) {
      const { data, error } = await supabase
        .from('invoice_drafts')
        .select('*, line_items(*)')
        .eq('id', draft_id)
        .single();
      if (error) return res.status(404).json({ success: false, error: 'Draft not found' });
      invoiceData = {
        client_name:     data.client_name,
        client_email:    data.client_email,
        client_address:  data.client_address,
        job_description: data.job_description,
        notes:           data.notes,
        line_items:      (data.line_items || []).map(li => ({
          service_name: li.service_name,
          description:  li.description,
          quantity:     li.quantity,
          unit_price:   li.unit_price,
          quickbooks_item_id:   li.quickbooks_item_id,
          quickbooks_item_name: li.quickbooks_item_name
        }))
      };
    }

    if (!invoiceData) {
      return res.status(400).json({ success: false, error: 'invoice or draft_id required' });
    }

    const payload = buildQBOInvoicePayload(invoiceData);
    const connected = isQBOConnected();

    res.json({
      success: true,
      dry_run: true,
      qbo_configured: isQBOConfigured(),
      qbo_connected:  connected,
      message: connected
        ? 'QBO credentials are present — use /api/quickbooks/create-invoice to create for real'
        : 'QBO not connected — this is what the invoice payload would look like',
      qbo_invoice_payload: payload
    });
  } catch (err) {
    console.error('[qb-dry-run] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/quickbooks/create-invoice
// Creates a real invoice in QBO using env-var tokens.
// Body: { draft_id: "uuid" }  OR  { invoice: { ... } }
app.post('/api/quickbooks/create-invoice', async (req, res) => {
  try {
    if (!isQBOConnected()) {
      return res.status(503).json({
        success: false,
        error: 'QuickBooks not connected',
        message: 'Missing one or more of: QBO_ACCESS_TOKEN, QBO_REALM_ID, INTUIT_CLIENT_ID, INTUIT_CLIENT_SECRET',
        missing_vars: ['INTUIT_CLIENT_ID','INTUIT_CLIENT_SECRET','QBO_ACCESS_TOKEN','QBO_REALM_ID'].filter(v => !process.env[v]),
        next_step: 'Visit GET /api/quickbooks/connect to get the OAuth URL, complete the flow, and paste the tokens into .env'
      });
    }

    const { invoice, draft_id } = req.body;
    let invoiceData = invoice;

    // Fetch from Supabase if draft_id was given
    if (!invoiceData && draft_id) {
      const { data, error } = await supabase
        .from('invoice_drafts')
        .select('*, line_items(*)')
        .eq('id', draft_id)
        .single();
      if (error) return res.status(404).json({ success: false, error: 'Draft not found' });
      invoiceData = {
        client_name:     data.client_name,
        client_email:    data.client_email,
        client_address:  data.client_address,
        job_description: data.job_description,
        notes:           data.notes,
        line_items:      (data.line_items || []).map(li => ({
          service_name: li.service_name,
          description:  li.description,
          quantity:     li.quantity,
          unit_price:   li.unit_price,
          quickbooks_item_id:   li.quickbooks_item_id,
          quickbooks_item_name: li.quickbooks_item_name
        }))
      };
    }

    if (!invoiceData) {
      return res.status(400).json({ success: false, error: 'invoice or draft_id required' });
    }

    console.log('[qb-create] Creating QBO invoice for:', invoiceData.client_name);

    const result = await createQBOInvoice(
      invoiceData,
      process.env.QBO_ACCESS_TOKEN,
      process.env.QBO_REALM_ID
    );

    console.log('[qb-create] QBO invoice created:', result.qbo_invoice_id);
    res.json({ success: true, ...result });

  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[qb-create] Error:', detail);
    res.status(status || 500).json({
      success: false,
      error: detail,
      hint: status === 401
        ? 'Access token expired — use QBO_REFRESH_TOKEN to get a new one, or reconnect via /api/quickbooks/connect'
        : undefined
    });
  }
});

// ============= END QUICKBOOKS =============

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Transcription provider: ${TRANSCRIPTION_PROVIDER}`);
  if (TRANSCRIPTION_PROVIDER === 'linux_ssh') {
    console.log(`SSH target: ${process.env.WHISPER_SSH_TARGET || 'not configured'}`);
  }
});
