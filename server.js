require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const { requireAuth, getAdminClient } = require('./middleware/auth');
const { transcribeAudio: transcribeAudioProvider } = require('./services/transcription/transcriber');
const { parseInvoiceFromTranscript } = require('./services/invoiceParser');
const {
  buildAuthUrl,
  exchangeCodeForTokens,
  buildQBOInvoicePayload,
  createQBOInvoice,
  getConnection,
  saveConnection,
  refreshIfNeeded,
  isQBOConfigured
} = require('./services/quickbooksService');

const app = express();
const PORT = process.env.PORT || 5001;
const TRANSCRIPTION_PROVIDER = process.env.TRANSCRIPTION_PROVIDER || 'openai_whisper';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Anonymous Supabase client (for unauth'd public reads only)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Multer for /upload route (audio, 25 MB max)
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

// CORS — restrict to configured origins; comma-separated list supported
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
  : true;
app.use(cors({ origin: corsOrigins, credentials: false }));
app.use(express.json());

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
    voice_transcription_available:
      TRANSCRIPTION_PROVIDER === 'openai_whisper' || TRANSCRIPTION_PROVIDER === 'linux_ssh',
    claude_configured: !!process.env.ANTHROPIC_API_KEY,
    openai_configured: !!process.env.OPENAI_API_KEY,
    quickbooks_configured: isQBOConfigured(),
    timestamp: new Date().toISOString()
  });
});

// ============= STEP 1 & 2: AUDIO UPLOAD + TRANSCRIPTION =============

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file provided', code: 'NO_FILE' });
    }

    const timestamp = Date.now();
    const fileName = `audio_${timestamp}.${req.file.originalname.split('.').pop()}`;

    const { error: uploadError } = await supabase.storage
      .from('invoice_audio')
      .upload(`uploads/${fileName}`, req.file.buffer, { contentType: req.file.mimetype });

    if (uploadError) {
      console.error('Storage error:', uploadError);
      return res.status(500).json({ success: false, error: 'Failed to upload file to storage', code: 'STORAGE_ERROR' });
    }

    const { data: publicUrlData } = supabase.storage
      .from('invoice_audio')
      .getPublicUrl(`uploads/${fileName}`);
    const audioFileUrl = publicUrlData.publicUrl;

    const transcriptionResult = await transcribeAudioProvider(req.file.buffer, audioFileUrl);

    if (transcriptionResult.success) {
      res.json({
        success: true,
        fileName,
        audioFileUrl,
        transcript: transcriptionResult.transcript,
        message: 'Audio uploaded and transcribed successfully',
        provider: TRANSCRIPTION_PROVIDER
      });
    } else {
      res.status(200).json({
        success: true,
        fileName,
        audioFileUrl,
        transcript: null,
        message: 'Audio uploaded but transcription failed',
        transcriptionError: transcriptionResult.error,
        code: 'TRANSCRIPTION_ERROR',
        provider: TRANSCRIPTION_PROVIDER
      });
    }
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ success: false, error: err.message, code: 'UPLOAD_ERROR' });
  }
});

app.post('/transcribe', async (req, res) => {
  try {
    const { audioFileUrl } = req.body;
    if (!audioFileUrl) {
      return res.status(400).json({ success: false, error: 'audioFileUrl is required', code: 'NO_AUDIO_URL' });
    }
    const audioResponse = await axios.get(audioFileUrl, { responseType: 'arraybuffer' });
    const transcriptionResult = await transcribeAudioProvider(audioResponse.data, audioFileUrl);

    if (transcriptionResult.success) {
      res.json({ success: true, transcript: transcriptionResult.transcript, message: 'Audio transcribed successfully', provider: TRANSCRIPTION_PROVIDER });
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
    res.status(500).json({ success: false, error: err.message, code: 'TRANSCRIBE_ERROR' });
  }
});

// ============= DEMO FALLBACK: PARSE TRANSCRIPT DIRECTLY =============

app.post('/api/parse-transcript', async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!transcript || transcript.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'transcript is required' });
    }
    const parseResult = await parseInvoiceFromTranscript(transcript);
    if (!parseResult.success) {
      return res.status(500).json({ success: false, error: parseResult.error, transcript });
    }
    res.json({ success: true, transcript, invoice: parseResult.invoice });
  } catch (err) {
    console.error('[parse-transcript] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============= STAGE 3: TRANSCRIBE + PARSE + SAVE =============
//
// POST /api/transcribe-and-process
//   Authorization: Bearer <supabase_access_token>
//   Body: { audio_file_url: "user-id/timestamp.webm" }

app.post('/api/transcribe-and-process', requireAuth, async (req, res) => {
  try {
    const { audio_file_url } = req.body;
    const userId = req.userId;

    if (!audio_file_url) {
      return res.status(400).json({ success: false, error: 'audio_file_url is required' });
    }

    const ext = audio_file_url.split('.').pop() || 'webm';
    const audioPublicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/audio-recordings/${audio_file_url}`;

    console.log(`[transcribe-and-process] user=${userId} audio=${audioPublicUrl} ext=${ext}`);

    // Step 1: Transcribe
    const transcriptionResult = await transcribeAudioProvider(null, audioPublicUrl, ext);
    if (!transcriptionResult.success) {
      console.error('[transcribe-and-process] Transcription failed:', transcriptionResult.error);
      return res.status(500).json({ success: false, error: 'Transcription failed: ' + transcriptionResult.error });
    }
    const { transcript } = transcriptionResult;
    console.log(`[transcribe-and-process] Transcript ${transcript.length} chars`);

    // Step 2: Parse with Claude
    const parseResult = await parseInvoiceFromTranscript(transcript);
    if (!parseResult.success) {
      console.error('[transcribe-and-process] Parsing failed:', parseResult.error);
      return res.status(500).json({ success: false, error: 'Invoice parsing failed: ' + parseResult.error, transcript });
    }
    const { invoice } = parseResult;
    console.log(`[transcribe-and-process] ${invoice.line_items.length} line items extracted`);

    // Look up the user's default tax rate
    const { data: profile } = await req.supabase
      .from('profiles')
      .select('default_tax_rate')
      .eq('id', userId)
      .maybeSingle();
    const taxRate = profile?.default_tax_rate ?? null;

    // Step 3: Insert draft (RLS-enforced via user-scoped client)
    const { data: draft, error: draftError } = await req.supabase
      .from('invoice_drafts')
      .insert({
        user_id: userId,
        transcript,
        audio_file_urls: [audio_file_url],
        status: 'draft',
        tax_rate: taxRate,
        client_name:      invoice.client_name || null,
        client_company:   invoice.client_company || null,
        client_phone:     invoice.client_phone || null,
        client_email:     invoice.client_email || null,
        client_address:   invoice.client_address || null,
        job_location:     invoice.job_location || null,
        job_description:  invoice.job_description || null,
        job_reference_number: invoice.job_reference_number || null,
        notes:            invoice.notes || null
      })
      .select()
      .single();

    if (draftError) {
      console.error('[transcribe-and-process] Failed to save draft:', draftError.message);
      return res.status(500).json({ success: false, error: 'Failed to save invoice draft: ' + draftError.message, transcript, invoice });
    }

    if (invoice.line_items?.length) {
      const rows = invoice.line_items.map((item, i) => ({
        draft_id: draft.id,
        service_name: item.service_name,
        description: item.description || null,
        category: item.category || 'other',
        quantity: typeof item.quantity === 'number' ? item.quantity : 1,
        unit: item.unit || 'ea',
        unit_price: typeof item.unit_price === 'number' ? item.unit_price : 0,
        is_taxable: item.is_taxable !== false,
        tax_rate: taxRate,
        line_order: i
      }));

      const { error: lineItemError } = await req.supabase.from('line_items').insert(rows);
      if (lineItemError) {
        console.error('[transcribe-and-process] Failed to save line items:', lineItemError.message);
      }
    }

    res.json({ success: true, draft_id: draft.id, transcript, invoice });
  } catch (err) {
    console.error('[transcribe-and-process] Unexpected error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============= QUICKBOOKS INTEGRATION =============

// GET /api/quickbooks/connect — returns the Intuit OAuth URL for this user
app.get('/api/quickbooks/connect', requireAuth, (req, res) => {
  try {
    if (!isQBOConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'QuickBooks not configured — INTUIT_CLIENT_ID / INTUIT_CLIENT_SECRET / INTUIT_REDIRECT_URI missing',
        missing_vars: ['INTUIT_CLIENT_ID', 'INTUIT_CLIENT_SECRET', 'INTUIT_REDIRECT_URI'].filter((v) => !process.env[v])
      });
    }
    res.json({ success: true, auth_url: buildAuthUrl(req.userId) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/quickbooks/callback — Intuit redirects here; we save tokens and bounce to the frontend
app.get('/api/quickbooks/callback', async (req, res) => {
  const { code, realmId, state, error: oauthError } = req.query;

  const errRedirect = (msg) =>
    res.redirect(`${FRONTEND_URL}/quickbooks/callback?error=1&message=${encodeURIComponent(msg)}`);

  if (oauthError) return errRedirect(String(oauthError));
  if (!code || !realmId) return errRedirect('Missing code or realmId in callback');
  if (!state) return errRedirect('Missing state in callback');

  try {
    const tokens = await exchangeCodeForTokens(code, realmId);
    const admin = getAdminClient();
    await saveConnection(admin, String(state), tokens);
    res.redirect(`${FRONTEND_URL}/quickbooks/success`);
  } catch (err) {
    console.error('[qb-callback] Error:', err.message);
    errRedirect(err.message);
  }
});

// POST /api/quickbooks/dry-run — preview the QBO payload without creating
app.post('/api/quickbooks/dry-run', requireAuth, async (req, res) => {
  try {
    const { invoice, draft_id } = req.body;
    let invoiceData = invoice;

    if (!invoiceData && draft_id) {
      const { data, error } = await req.supabase
        .from('invoice_drafts')
        .select('*, line_items(*)')
        .eq('id', draft_id)
        .single();
      if (error) return res.status(404).json({ success: false, error: 'Draft not found' });
      invoiceData = draftRowToInvoice(data);
    }

    if (!invoiceData) {
      return res.status(400).json({ success: false, error: 'invoice or draft_id required' });
    }

    const connection = await getConnection(req.supabaseAdmin, req.userId);
    const payload = buildQBOInvoicePayload(invoiceData);

    res.json({
      success: true,
      dry_run: true,
      qbo_configured: isQBOConfigured(),
      qbo_connected: !!connection?.is_connected,
      message: connection?.is_connected
        ? 'QB connected — use /api/quickbooks/create-invoice to create for real'
        : 'QB not connected — preview only',
      qbo_invoice_payload: payload
    });
  } catch (err) {
    console.error('[qb-dry-run] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/quickbooks/create-invoice — create a real invoice in QBO
app.post('/api/quickbooks/create-invoice', requireAuth, async (req, res) => {
  try {
    if (!isQBOConfigured()) {
      return res.status(503).json({ success: false, error: 'QuickBooks not configured' });
    }

    let connection = await getConnection(req.supabaseAdmin, req.userId);
    if (!connection?.is_connected) {
      return res.status(403).json({
        success: false,
        error: 'QuickBooks not connected for this user',
        next_step: 'Visit GET /api/quickbooks/connect to start the OAuth flow'
      });
    }

    connection = await refreshIfNeeded(req.supabaseAdmin, connection);

    const { invoice, draft_id } = req.body;
    let invoiceData = invoice;

    if (!invoiceData && draft_id) {
      const { data, error } = await req.supabase
        .from('invoice_drafts')
        .select('*, line_items(*)')
        .eq('id', draft_id)
        .single();
      if (error) return res.status(404).json({ success: false, error: 'Draft not found' });
      invoiceData = draftRowToInvoice(data);
    }

    if (!invoiceData) {
      return res.status(400).json({ success: false, error: 'invoice or draft_id required' });
    }

    const result = await createQBOInvoice(invoiceData, connection);

    // If we have a draft_id, write back the QB invoice metadata
    if (draft_id) {
      await req.supabase
        .from('invoice_drafts')
        .update({
          quickbooks_invoice_id:  result.qbo_invoice_id,
          quickbooks_doc_number:  result.qbo_invoice_num,
          quickbooks_status:      'synced',
          synced_at:              new Date().toISOString()
        })
        .eq('id', draft_id);
    }

    // Bump last_sync_at on the connection
    await req.supabaseAdmin
      .from('quickbooks_connections')
      .update({ last_sync_at: new Date().toISOString(), last_sync_status: 'success', last_error: null })
      .eq('id', connection.id);

    res.json({ success: true, ...result });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[qb-create] Error:', detail);

    // Record sync failure if we have a connection
    try {
      const conn = await getConnection(req.supabaseAdmin, req.userId);
      if (conn) {
        await req.supabaseAdmin
          .from('quickbooks_connections')
          .update({ last_sync_status: 'failed', last_error: detail, sync_error_count: (conn.sync_error_count || 0) + 1 })
          .eq('id', conn.id);
      }
    } catch { /* swallow */ }

    res.status(status || 500).json({
      success: false,
      error: detail,
      hint: status === 401 ? 'Access token may be expired — try reconnecting via /api/quickbooks/connect' : undefined
    });
  }
});

// Helper: map a Supabase invoice_drafts row + line_items into the shape the QBO mapper expects
function draftRowToInvoice(row) {
  return {
    client_name:     row.client_name,
    client_email:    row.client_email,
    client_address:  row.client_address,
    job_description: row.job_description,
    notes:           row.notes,
    quickbooks_customer_id: row.quickbooks_customer_id,
    line_items: (row.line_items || []).map((li) => ({
      service_name:         li.service_name,
      description:          li.description,
      quantity:             li.quantity,
      unit_price:           li.unit_price,
      quickbooks_item_id:   li.quickbooks_item_id,
      quickbooks_item_name: li.quickbooks_item_name
    }))
  };
}

// ============= START SERVER =============
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Transcription provider: ${TRANSCRIPTION_PROVIDER}`);
  console.log(`Frontend URL (for QB redirect): ${FRONTEND_URL}`);
});
