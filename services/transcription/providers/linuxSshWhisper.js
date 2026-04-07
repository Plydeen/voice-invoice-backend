/**
 * Linux SSH Whisper Provider
 * Executes Whisper transcription remotely on Linux box via SSH.
 *
 * What this does:
 *   1. SSH into the Linux box (using the "linuxbox" alias from ~/.ssh/config)
 *   2. Linux box downloads the audio file directly from Supabase using curl
 *   3. Linux box activates the Whisper virtual environment
 *   4. Linux box runs Whisper with JSON output
 *   5. Linux box prints the JSON result back to us
 *   6. We parse the JSON and return the transcript
 *   7. Linux box cleans up temp files
 *
 * Required in .env:
 *   TRANSCRIPTION_PROVIDER=linux_ssh
 *   WHISPER_SSH_TARGET=linuxbox
 *   WHISPER_REMOTE_VENV_PATH=/home/blueweb/whisper-env
 *
 * SSH setup (one-time, run in Mac Terminal):
 *   ssh-add --apple-use-keychain ~/.ssh/id_ed25519
 *   ssh linuxbox echo ok     ← should print "ok" with no password prompt
 */

const { exec } = require('child_process')

/**
 * Transcribe audio using remote Linux Whisper over SSH.
 *
 * @param {Buffer} audioBuffer  - Not used here; audio is fetched remotely from Supabase
 * @param {string} audioFileUrl - Public Supabase URL the Linux box will download
 * @returns {Promise<{success: boolean, transcript: string|null, error: string|null}>}
 */
async function transcribeAudio(audioBuffer, audioFileUrl) {
  const remoteVenvPath = process.env.WHISPER_REMOTE_VENV_PATH || '/home/blueweb/whisper-env'
  const sshTarget = process.env.WHISPER_SSH_TARGET || process.env.WHISPER_SSH_HOST || 'linuxbox'

  if (!audioFileUrl) {
    return { success: false, transcript: null, error: 'audioFileUrl is required' }
  }

  // Build the remote bash script as a list of commands joined by semicolons.
  // Each step:
  //   - mktemp creates a unique temp base path like /tmp/whisper_abc123
  //   - curl downloads the audio from Supabase into /tmp/whisper_abc123.mp3
  //   - source activates the Python virtual environment
  //   - whisper transcribes and writes /tmp/whisper_abc123.json
  //   - cat prints the JSON so we receive it as stdout
  //   - rm cleans up all temp files
  //
  // IMPORTANT: We use single quotes around this script when passing to SSH.
  // That tells the Mac shell "don't expand $REMOTE_BASE etc. here — let Linux do it."
  // The only value we inject from Node is audioFileUrl and remoteVenvPath,
  // which are embedded directly before the single-quote wrapping happens.
  const remoteScript = [
    'set -e',
    'REMOTE_BASE=$(mktemp /tmp/whisper_XXXXXX)',
    'REMOTE_AUDIO="${REMOTE_BASE}.mp3"',
    `curl -fsSL -o "$REMOTE_AUDIO" "${audioFileUrl}"`,
    `. "${remoteVenvPath}/bin/activate"`,
    // --verbose False suppresses the language/timestamp chatter.
    // >/dev/null 2>&1 discards anything whisper still prints to stdout/stderr.
    // Only the cat below sends anything back through SSH stdout.
    'whisper "$REMOTE_AUDIO" --output_format json --output_dir /tmp --verbose False >/dev/null 2>&1',
    'cat "${REMOTE_BASE}.json"',
    'rm -f "$REMOTE_AUDIO" "${REMOTE_BASE}.json" "$REMOTE_BASE"'
  ].join('; ')

  // Single-quote the script so the Mac shell passes it verbatim to Linux.
  const cmd = `ssh ${sshTarget} '${remoteScript}'`

  console.log(`Starting SSH transcription via: ssh ${sshTarget}`)

  return new Promise((resolve) => {
    exec(cmd, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        console.error('SSH transcription error:', stderr || error.message)
        return resolve({
          success: false,
          transcript: null,
          error: 'SSH command failed: ' + (stderr || error.message).trim()
        })
      }

      // Extract and parse the Whisper JSON from stdout.
      //
      // Strategy (in order):
      //   1. Try parsing stdout directly as pure JSON — cleanest case.
      //   2. If that fails, find the first { and the last } and parse that
      //      substring. This handles any stray chatter lines before/after
      //      the JSON object. We use first { because Whisper's JSON starts
      //      at the top-level object, and last } because nested segment
      //      objects mean lastIndexOf('{') would land inside the JSON.
      const raw = stdout.trim()

      let jsonStr = null

      // Attempt 1: pure JSON
      try {
        JSON.parse(raw)
        jsonStr = raw
      } catch (_) {
        // Attempt 2: slice from first { to last }
        const start = raw.indexOf('{')
        const end = raw.lastIndexOf('}')
        if (start !== -1 && end !== -1 && end > start) {
          jsonStr = raw.slice(start, end + 1)
        }
      }

      if (!jsonStr) {
        console.error('No JSON object found in stdout. Full stdout:', raw.slice(0, 500))
        return resolve({
          success: false,
          transcript: null,
          error: 'Whisper output contained no JSON object'
        })
      }

      try {
        const parsed = JSON.parse(jsonStr)
        const transcript = parsed.text ? parsed.text.trim() : null

        if (!transcript) {
          return resolve({
            success: false,
            transcript: null,
            error: 'Whisper returned an empty transcript'
          })
        }

        console.log('Transcription complete. Characters:', transcript.length)
        resolve({ success: true, transcript, error: null })

      } catch (parseErr) {
        console.error('Failed to parse Whisper JSON output.')
        console.error('stdout preview:', raw.slice(0, 500))
        resolve({
          success: false,
          transcript: null,
          error: 'Could not parse Whisper output as JSON: ' + parseErr.message
        })
      }
    })
  })
}

module.exports = { transcribeAudio }
