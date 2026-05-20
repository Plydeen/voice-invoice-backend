/**
 * OpenAI Whisper Transcription Provider
 *
 * Cloud-friendly transcription that runs anywhere (Railway, etc.). Downloads the
 * audio file from the given public URL, then POSTs it as multipart form-data
 * to https://api.openai.com/v1/audio/transcriptions.
 *
 * Env: OPENAI_API_KEY
 *
 * Contract matches the other providers in this directory:
 *   async transcribeAudio(audioBuffer, audioFileUrl, fileExtension)
 *     → { success, transcript, provider, error?, code? }
 *
 * If `audioBuffer` is provided we use it directly; otherwise we fetch from
 * `audioFileUrl` (the path the frontend uploaded to Supabase Storage).
 */

const axios = require('axios');
const FormData = require('form-data');

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'whisper-1';

async function transcribeAudio(audioBuffer, audioFileUrl, fileExtension) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      transcript: null,
      error: 'OPENAI_API_KEY is not configured',
      code: 'OPENAI_KEY_MISSING'
    };
  }

  try {
    let buffer = audioBuffer;
    if (!buffer) {
      if (!audioFileUrl) {
        return {
          success: false,
          transcript: null,
          error: 'No audio buffer or URL provided',
          code: 'NO_AUDIO'
        };
      }
      const audioResponse = await axios.get(audioFileUrl, {
        responseType: 'arraybuffer',
        timeout: 30_000
      });
      buffer = Buffer.from(audioResponse.data);
    }

    const ext = (fileExtension || (audioFileUrl ? audioFileUrl.split('.').pop() : '') || 'webm')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '') || 'webm';

    const form = new FormData();
    form.append('file', buffer, { filename: `audio.${ext}`, contentType: `audio/${ext}` });
    form.append('model', MODEL);
    form.append('response_format', 'json');

    const response = await axios.post(OPENAI_TRANSCRIBE_URL, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${apiKey}`
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120_000
    });

    const transcript = response.data?.text?.trim() || '';
    if (!transcript) {
      return {
        success: false,
        transcript: null,
        error: 'OpenAI returned an empty transcript',
        code: 'EMPTY_TRANSCRIPT'
      };
    }

    return {
      success: true,
      transcript,
      provider: 'openai_whisper'
    };
  } catch (err) {
    const detail = err.response?.data
      ? (typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data))
      : err.message;
    return {
      success: false,
      transcript: null,
      error: `OpenAI Whisper request failed: ${detail}`,
      code: 'OPENAI_REQUEST_FAILED'
    };
  }
}

module.exports = { transcribeAudio };
