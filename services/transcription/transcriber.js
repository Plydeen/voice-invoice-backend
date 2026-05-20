/**
 * Transcription Module
 * Central dispatcher for transcription providers.
 *
 * Supported values for TRANSCRIPTION_PROVIDER:
 *   none / disabled   — audio transcription off; returns a clear error (default / Railway)
 *   linux_ssh         — remote Whisper over SSH (local development only)
 *
 * Future providers (not yet implemented):
 *   openai_whisper    — OpenAI Whisper API (cloud-safe)
 *   deepgram          — Deepgram API (cloud-safe)
 */

const PROVIDER = process.env.TRANSCRIPTION_PROVIDER || 'none'

let transcriber

switch (PROVIDER) {
  case 'linux_ssh':
    transcriber = require('./providers/linuxSshWhisper')
    break

  case 'none':
  case 'disabled':
    transcriber = require('./providers/disabled')
    break

  default:
    console.warn(
      `[transcriber] Unknown TRANSCRIPTION_PROVIDER: "${PROVIDER}". ` +
      'Audio transcription disabled. Supported values: none, disabled, linux_ssh.'
    )
    transcriber = require('./providers/disabled')
}

module.exports = transcriber
