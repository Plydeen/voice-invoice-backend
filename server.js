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

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Transcription provider: ${TRANSCRIPTION_PROVIDER}`);
  if (TRANSCRIPTION_PROVIDER === 'linux_ssh') {
    console.log(`SSH target: ${process.env.WHISPER_SSH_TARGET || 'not configured'}`);
  }
});
