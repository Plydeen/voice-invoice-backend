/**
 * Transcription Module
 * Central dispatcher for transcription providers.
 *
 * Supported values for TRANSCRIPTION_PROVIDER:
 *   openai_whisper    — OpenAI Whisper API (cloud-safe; Railway default)
 *   linux_ssh         — remote Whisper over SSH (local dev only)
 *   none / disabled   — audio transcription off; returns a clear error
 */

const PROVIDER = process.env.TRANSCRIPTION_PROVIDER || 'openai_whisper'

let transcriber

switch (PROVIDER) {
  case 'openai_whisper':
    transcriber = require('./providers/openaiWhisper')
    break

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
      'Audio transcription disabled. Supported values: openai_whisper, linux_ssh, none, disabled.'
    )
    transcriber = require('./providers/disabled')
}

module.exports = transcriber
