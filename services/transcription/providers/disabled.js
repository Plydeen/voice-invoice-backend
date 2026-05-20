/**
 * Disabled Transcription Provider
 *
 * Used when TRANSCRIPTION_PROVIDER=none, TRANSCRIPTION_PROVIDER=disabled,
 * or when TRANSCRIPTION_PROVIDER is not set.
 *
 * Audio transcription is not available in cloud/Railway deployments because:
 *   - Railway does not have SSH keys to reach the local Linux box
 *   - Railway does not have local network access to that machine
 *
 * For demos and production use the text-only route instead:
 *   POST /api/parse-transcript   { "transcript": "..." }
 *
 * To re-enable audio transcription later, add a cloud speech-to-text provider
 * (e.g. OpenAI Whisper API) and set TRANSCRIPTION_PROVIDER=openai_whisper.
 */

async function transcribeAudio(audioBuffer, audioFileUrl, fileExtension) {
  return {
    success: false,
    transcript: null,
    error:
      'Audio transcription is disabled in this deployment. ' +
      'Use POST /api/parse-transcript with a text transcript for the demo. ' +
      'To enable audio transcription, configure a cloud speech-to-text provider ' +
      'and set TRANSCRIPTION_PROVIDER accordingly.',
    code: 'TRANSCRIPTION_DISABLED'
  }
}

module.exports = { transcribeAudio }
