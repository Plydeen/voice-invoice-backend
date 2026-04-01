require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
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
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    // Only allow audio files (check if mime type starts with "audio/")
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  }
});

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Voice Invoice API — alive' });
});

// Upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    // Check if file exists
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file provided',
        code: 'NO_FILE'
      });
    }

    // Create a unique filename
    const timestamp = Date.now();
    const fileName = `audio_${timestamp}.${req.file.originalname.split('.').pop()}`;

    // Upload to Supabase Storage
    const { data, error: uploadError } = await supabase.storage
      .from('invoice_audio') // bucket name
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

    // Get public URL for the uploaded file
    const { data: publicUrlData } = supabase.storage
      .from('invoice_audio')
      .getPublicUrl(`uploads/${fileName}`);

    const audioFileUrl = publicUrlData.publicUrl;

    // For now, just return success (we'll add database save later)
    res.json({
      success: true,
      fileName: fileName,
      audioFileUrl: audioFileUrl,
      message: 'Audio uploaded successfully'
    });

  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'UPLOAD_ERROR'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});