/**
 * Invoice Parser
 * Sends a voice transcript to the Claude API and extracts structured invoice data.
 *
 * What this does:
 *   1. Takes the raw text transcript from Whisper
 *   2. Sends it to Claude with a prompt describing exactly what fields to extract
 *   3. Claude returns a JSON object with draft-level fields and a line_items array
 *   4. We parse and return that JSON
 *
 * Required in .env:
 *   ANTHROPIC_API_KEY=sk-ant-...
 *
 * The returned invoice object matches what server.js writes to invoice_drafts + line_items.
 */

const axios = require('axios')

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'  // Fast and cheap for extraction tasks

const SYSTEM_PROMPT = `You are an invoice data extractor for field service contractors (plumbers, electricians, HVAC techs, etc.).
Your job is to read a voice transcript and extract structured invoice information.
You must return ONLY a valid JSON object — no explanation, no markdown, no extra text.`

/**
 * Parse a voice transcript into structured invoice fields using Claude API.
 *
 * @param {string} transcript - The raw Whisper transcript text
 * @returns {Promise<{success: boolean, invoice: object|null, error: string|null}>}
 */
async function parseInvoiceFromTranscript(transcript) {
  const apiKey = process.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set in .env')
    return { success: false, invoice: null, error: 'ANTHROPIC_API_KEY is not configured' }
  }

  if (!transcript || transcript.trim().length === 0) {
    return { success: false, invoice: null, error: 'Transcript is empty' }
  }

  // The prompt tells Claude exactly what fields to extract and what format to use.
  // We use a few examples in the rules to reduce hallucination.
  const userMessage = `Extract invoice information from this voice transcript and return it as JSON.

Transcript:
"""
${transcript}
"""

Return ONLY a JSON object with this exact structure (use null for any fields not mentioned):
{
  "client_name": "full name of the client/customer, or null",
  "client_company": "company name, or null",
  "client_phone": "phone number as spoken, or null",
  "client_email": "email address, or null",
  "client_address": "client mailing address, or null",
  "job_location": "address where the work was done, or null",
  "job_description": "one or two sentence summary of the overall job, or null",
  "job_reference_number": "any job number, PO number, or reference number mentioned, or null",
  "notes": "anything else worth capturing that doesn't fit above, or null",
  "line_items": [
    {
      "service_name": "short name of the service or material (required)",
      "description": "additional detail about this item, or null",
      "category": "one of: labor, materials, equipment, subcontractor, other",
      "quantity": 1,
      "unit": "one of: ea, hr, sqft, lf, day, lot",
      "unit_price": 0.00,
      "is_taxable": true
    }
  ]
}

Rules:
- service_name is required for every line item — never omit it
- category must be exactly one of: labor, materials, equipment, subcontractor, other
- unit must be exactly one of: ea, hr, sqft, lf, day, lot
- quantity and unit_price must be numbers (use 1 and 0 if not mentioned)
- is_taxable: use true for labor/services, false for materials (unless stated otherwise)
- Create one line item per distinct service or material mentioned
- If no price is mentioned for an item, set unit_price to 0
- If only a total is mentioned with no breakdown, create one line item with that total as unit_price`

  try {
    console.log('Sending transcript to Claude for invoice parsing...')

    const response = await axios.post(CLAUDE_API_URL, {
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userMessage }
      ]
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 30000  // 30 seconds — Claude is usually fast for extraction
    })

    const rawText = response.data.content[0].text.trim()

    // Parse the JSON from Claude's response.
    // Strategy: try pure parse first, then fall back to extracting { ... } if there's any surrounding text.
    let invoice
    try {
      invoice = JSON.parse(rawText)
    } catch (_) {
      // Sometimes Claude adds a tiny bit of text before/after — strip it
      const start = rawText.indexOf('{')
      const end = rawText.lastIndexOf('}')
      if (start !== -1 && end !== -1 && end > start) {
        invoice = JSON.parse(rawText.slice(start, end + 1))
      } else {
        throw new Error('No JSON object found in Claude response')
      }
    }

    // Make sure line_items is always an array
    if (!invoice.line_items || !Array.isArray(invoice.line_items)) {
      invoice.line_items = []
    }

    console.log(`Invoice parsing complete. Line items: ${invoice.line_items.length}`)
    return { success: true, invoice, error: null }

  } catch (err) {
    // If it's an Axios error with a response, log the API error details
    if (err.response) {
      const apiError = JSON.stringify(err.response.data)
      console.error('Claude API error:', apiError)
      return { success: false, invoice: null, error: 'Claude API error: ' + apiError }
    }

    console.error('Invoice parsing error:', err.message)
    return { success: false, invoice: null, error: err.message }
  }
}

module.exports = { parseInvoiceFromTranscript }
