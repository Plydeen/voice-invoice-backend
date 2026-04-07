/**
 * Transcription Module
 * Central dispatcher for transcription providers
 * Current provider: Linux SSH Whisper (for development)
 * Future provider: OpenAI Whisper API (for production)
 */

// Load provider from environment
const PROVIDER = process.env.TRANSCRIPTION_PROVIDER || 'linux_ssh';

let transcriber;

switch (PROVIDER) {
  case 'linux_ssh':
    transcriber = require('./providers/linuxSshWhisper');
    break;
  default:
    console.error(`Unknown transcription provider: ${PROVIDER}`);
    console.error('Falling back to linux_ssh provider');
    transcriber = require('./providers/linuxSshWhisper');
}

module.exports = transcriber;
