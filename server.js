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
const TRANSCRIPTION_PROVIDER = process.env.TRANSCRIPTION_PROVIDER || 'linux_ssh';

// Invoice parser (uses Claude API)
const { parseInvoiceFromTranscript } = require('./services/invoiceParser');

console.log(`Using transcription provider: ${TRANSCRIPTION_PROVIDER}`);

// ============= HEALTH CHECK =============

app.get('/', (req, res) => {
  res.json({ message: 'Voice Invoice API - alive', provider: TRANSCRIPTION_PROVIDER });
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

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Transcription provider: ${TRANSCRIPTION_PROVIDER}`);
  if (TRANSCRIPTION_PROVIDER === 'linux_ssh') {
    console.log(`SSH target: ${process.env.WHISPER_SSH_TARGET || 'not configured'}`);
  }
});
