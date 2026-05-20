/**
 * QuickBooks Online Service
 * Handles OAuth 2.0 connection and invoice creation via the QBO REST API.
 *
 * ── What this file does ──────────────────────────────────────────────────────
 *   1. buildAuthUrl()         → Returns the Intuit OAuth URL to redirect the user
 *   2. exchangeCodeForTokens()→ Trades the auth code for access + refresh tokens
 *   3. refreshAccessToken()   → Gets a new access token using the refresh token
 *   4. buildQBOInvoicePayload()→ Maps our internal invoice JSON → QBO REST format
 *   5. createQBOInvoice()     → POSTs the invoice to QBO and returns the result
 *
 * ── Required env vars ────────────────────────────────────────────────────────
 *   INTUIT_CLIENT_ID        From Intuit Developer Portal → your app → Keys
 *   INTUIT_CLIENT_SECRET    From Intuit Developer Portal → your app → Keys
 *   INTUIT_REDIRECT_URI     Must exactly match what's in your Intuit app settings
 *                           Example: http://localhost:5001/api/quickbooks/callback
 *   INTUIT_ENVIRONMENT      sandbox  (use "production" when ready to go live)
 *   QBO_REALM_ID            The company's QuickBooks company ID (from OAuth callback)
 *   QBO_ACCESS_TOKEN        Current OAuth access token (short-lived, ~1 hour)
 *   QBO_REFRESH_TOKEN       OAuth refresh token (long-lived, ~100 days)
 *
 * ── Intuit Developer setup checklist ────────────────────────────────────────
 *   1. Go to https://developer.intuit.com
 *   2. Create an app → select "QuickBooks Online and Payments"
 *   3. Under "Keys & OAuth" copy Client ID and Client Secret
 *   4. Add redirect URI: http://localhost:5001/api/quickbooks/callback
 *   5. Under "App Settings" → select Sandbox environment
 *   6. Use the sandbox company at: https://developer.intuit.com/app/developer/sandbox
 */

const axios = require('axios');

// ── OAuth endpoints ──────────────────────────────────────────────────────────
const INTUIT_AUTH_URL     = 'https://appcenter.intuit.com/connect/oauth2';
const INTUIT_TOKEN_URL    = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const INTUIT_REVOKE_URL   = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

// ── QBO REST API base ────────────────────────────────────────────────────────
function getQBOBaseUrl() {
  const env = process.env.INTUIT_ENVIRONMENT || 'sandbox';
  return env === 'production'
    ? 'https://quickbooks.api.intuit.com/v3/company'
    : 'https://sandbox-quickbooks.api.intuit.com/v3/company';
}

// ── 1. Build the OAuth authorization URL ────────────────────────────────────
function buildAuthUrl() {
  const clientId     = process.env.INTUIT_CLIENT_ID;
  const redirectUri  = process.env.INTUIT_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    throw new Error('INTUIT_CLIENT_ID and INTUIT_REDIRECT_URI must be set in .env');
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'com.intuit.quickbooks.accounting',
    state:         'voice_invoice_' + Date.now()
  });

  return `${INTUIT_AUTH_URL}?${params.toString()}`;
}

// ── 2. Exchange authorization code for tokens ────────────────────────────────
async function exchangeCodeForTokens(code, realmId) {
  const clientId     = process.env.INTUIT_CLIENT_ID;
  const clientSecret = process.env.INTUIT_CLIENT_SECRET;
  const redirectUri  = process.env.INTUIT_REDIRECT_URI;

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await axios.post(INTUIT_TOKEN_URL, new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    redirect_uri: redirectUri
  }).toString(), {
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'Accept':        'application/json'
    }
  });

  return {
    access_token:  response.data.access_token,
    refresh_token: response.data.refresh_token,
    expires_in:    response.data.expires_in,
    realm_id:      realmId
  };
}

// ── 3. Refresh an expired access token ──────────────────────────────────────
async function refreshAccessToken(refreshToken) {
  const clientId     = process.env.INTUIT_CLIENT_ID;
  const clientSecret = process.env.INTUIT_CLIENT_SECRET;
  const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await axios.post(INTUIT_TOKEN_URL, new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken
  }).toString(), {
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'Accept':        'application/json'
    }
  });

  return {
    access_token:  response.data.access_token,
    refresh_token: response.data.refresh_token || refreshToken,
    expires_in:    response.data.expires_in
  };
}

// ── 4. Map internal invoice JSON → QBO Invoice payload ──────────────────────
//
// QBO requires CustomerRef (an existing customer ID in QBO) for every invoice.
// For the demo we'll use a fallback customer ID of "1" which is always the
// first customer in a sandbox company.
//
// Line items require a SalesItemLineDetail with ItemRef.
// We use ItemRef value "1" (first item in the sandbox) when no QB item is mapped.
// In production, you'd look up or create the customer/item by name.
//
function buildQBOInvoicePayload(invoice) {
  const lines = (invoice.line_items || []).map((item) => ({
    Amount: (item.quantity || 1) * (item.unit_price || 0),
    DetailType: 'SalesItemLineDetail',
    Description: [item.service_name, item.description].filter(Boolean).join(' — '),
    SalesItemLineDetail: {
      ItemRef: {
        // In sandbox, "1" is always a valid item (Services).
        // For production: look up item by name or create it.
        value: item.quickbooks_item_id || '1',
        name:  item.quickbooks_item_name || item.service_name || 'Services'
      },
      Qty:       item.quantity  || 1,
      UnitPrice: item.unit_price || 0
    }
  }));

  // Add a subtotal line at the end so QBO shows a proper total
  if (lines.length === 0) {
    lines.push({
      Amount: 0,
      DetailType: 'SalesItemLineDetail',
      Description: 'Voice Invoice',
      SalesItemLineDetail: {
        ItemRef: { value: '1', name: 'Services' },
        Qty: 1,
        UnitPrice: 0
      }
    });
  }

  return {
    Line: lines,
    CustomerRef: {
      // Sandbox always has customer "1". Production: look up by client_name.
      value: '1',
      name:  invoice.client_name || 'Customer'
    },
    BillEmail: invoice.client_email
      ? { Address: invoice.client_email }
      : undefined,
    BillAddr: invoice.client_address
      ? { Line1: invoice.client_address }
      : undefined,
    CustomerMemo: invoice.job_description
      ? { value: invoice.job_description }
      : undefined,
    PrivateNote: invoice.notes || undefined,
    DueDate: undefined  // Let QBO use its default payment terms
  };
}

// ── 5. Create an invoice in QBO ───────────────────────────────────────────────
async function createQBOInvoice(invoice, accessToken, realmId) {
  const baseUrl = getQBOBaseUrl();
  const payload = buildQBOInvoicePayload(invoice);

  const response = await axios.post(
    `${baseUrl}/${realmId}/invoice`,
    { Invoice: payload },
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
      }
    }
  );

  const qboInvoice = response.data.Invoice;
  return {
    qbo_invoice_id:  qboInvoice.Id,
    qbo_invoice_num: qboInvoice.DocNumber,
    total:           qboInvoice.TotalAmt,
    status:          qboInvoice.EmailStatus || 'NotSet',
    view_url: `https://app.${process.env.INTUIT_ENVIRONMENT === 'production' ? '' : 'sandbox.'}qbo.intuit.com/app/invoice?txnId=${qboInvoice.Id}`
  };
}

// ── Check whether QBO credentials are configured ─────────────────────────────
function isQBOConfigured() {
  return !!(
    process.env.INTUIT_CLIENT_ID &&
    process.env.INTUIT_CLIENT_SECRET &&
    process.env.INTUIT_REDIRECT_URI
  );
}

function isQBOConnected() {
  return !!(
    isQBOConfigured() &&
    process.env.QBO_ACCESS_TOKEN &&
    process.env.QBO_REALM_ID
  );
}

module.exports = {
  buildAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  buildQBOInvoicePayload,
  createQBOInvoice,
  isQBOConfigured,
  isQBOConnected
};
