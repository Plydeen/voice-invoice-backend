/**
 * QuickBooks Online Service
 * OAuth 2.0 connection + invoice creation, with per-user token persistence in
 * Supabase (`quickbooks_connections` table).
 *
 * Required env vars:
 *   INTUIT_CLIENT_ID
 *   INTUIT_CLIENT_SECRET
 *   INTUIT_REDIRECT_URI       must exactly match the URI registered in Intuit
 *   INTUIT_ENVIRONMENT        'sandbox' | 'production' (default: sandbox)
 */

const axios = require('axios');

const INTUIT_AUTH_URL  = 'https://appcenter.intuit.com/connect/oauth2';
const INTUIT_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function getQBOBaseUrl() {
  const env = process.env.INTUIT_ENVIRONMENT || 'sandbox';
  return env === 'production'
    ? 'https://quickbooks.api.intuit.com/v3/company'
    : 'https://sandbox-quickbooks.api.intuit.com/v3/company';
}

// ── 1. OAuth authorization URL (state carries user_id) ──────────────────────
function buildAuthUrl(userId) {
  const clientId    = process.env.INTUIT_CLIENT_ID;
  const redirectUri = process.env.INTUIT_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    throw new Error('INTUIT_CLIENT_ID and INTUIT_REDIRECT_URI must be set');
  }
  if (!userId) {
    throw new Error('userId is required to build an OAuth URL');
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'com.intuit.quickbooks.accounting',
    state:         userId
  });

  return `${INTUIT_AUTH_URL}?${params.toString()}`;
}

// ── 2. Exchange authorization code for tokens ────────────────────────────────
async function exchangeCodeForTokens(code, realmId) {
  const clientId     = process.env.INTUIT_CLIENT_ID;
  const clientSecret = process.env.INTUIT_CLIENT_SECRET;
  const redirectUri  = process.env.INTUIT_REDIRECT_URI;
  const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await axios.post(INTUIT_TOKEN_URL, new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    redirect_uri: redirectUri
  }).toString(), {
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    }
  });

  return {
    access_token:               response.data.access_token,
    refresh_token:              response.data.refresh_token,
    expires_in:                 response.data.expires_in,            // seconds
    x_refresh_token_expires_in: response.data.x_refresh_token_expires_in,
    realm_id:                   realmId
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
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    }
  });

  return {
    access_token:               response.data.access_token,
    refresh_token:              response.data.refresh_token || refreshToken,
    expires_in:                 response.data.expires_in,
    x_refresh_token_expires_in: response.data.x_refresh_token_expires_in
  };
}

// ── Supabase persistence ─────────────────────────────────────────────────────

async function getConnection(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('quickbooks_connections')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load QB connection: ${error.message}`);
  return data;
}

async function saveConnection(supabaseAdmin, userId, tokens, companyInfo = {}) {
  const now = Date.now();
  const tokenExpiresAt = new Date(now + (tokens.expires_in || 3600) * 1000).toISOString();
  const refreshExpiresAt = tokens.x_refresh_token_expires_in
    ? new Date(now + tokens.x_refresh_token_expires_in * 1000).toISOString()
    : null;

  const row = {
    user_id:                  userId,
    realm_id:                 tokens.realm_id,
    access_token:             tokens.access_token,
    refresh_token:            tokens.refresh_token,
    token_expires_at:         tokenExpiresAt,
    refresh_token_expires_at: refreshExpiresAt,
    is_connected:             true,
    connected_at:             new Date().toISOString(),
    updated_at:               new Date().toISOString(),
    company_name:             companyInfo.company_name ?? null,
    company_email:            companyInfo.company_email ?? null,
    company_phone:            companyInfo.company_phone ?? null,
    company_address:          companyInfo.company_address ?? null,
    company_currency:         companyInfo.company_currency ?? null
  };

  // Strip nulls so we don't overwrite existing values on reconnect
  Object.keys(row).forEach((k) => { if (row[k] === null || row[k] === undefined) delete row[k]; });

  const { data, error } = await supabaseAdmin
    .from('quickbooks_connections')
    .upsert(row, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) throw new Error(`Failed to save QB connection: ${error.message}`);
  return data;
}

async function refreshIfNeeded(supabaseAdmin, connection) {
  if (!connection) return null;
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0;
  // Refresh if expiring in the next 5 minutes
  if (expiresAt - Date.now() > 5 * 60 * 1000) return connection;

  const refreshed = await refreshAccessToken(connection.refresh_token);
  const tokenExpiresAt = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
  const refreshExpiresAt = refreshed.x_refresh_token_expires_in
    ? new Date(Date.now() + refreshed.x_refresh_token_expires_in * 1000).toISOString()
    : connection.refresh_token_expires_at;

  const { data, error } = await supabaseAdmin
    .from('quickbooks_connections')
    .update({
      access_token:             refreshed.access_token,
      refresh_token:            refreshed.refresh_token,
      token_expires_at:         tokenExpiresAt,
      refresh_token_expires_at: refreshExpiresAt,
      updated_at:               new Date().toISOString()
    })
    .eq('id', connection.id)
    .select()
    .single();
  if (error) throw new Error(`Failed to update refreshed tokens: ${error.message}`);
  return data;
}

// ── Map internal invoice JSON → QBO Invoice payload ─────────────────────────
function buildQBOInvoicePayload(invoice) {
  const lines = (invoice.line_items || []).map((item) => ({
    Amount: (item.quantity || 1) * (item.unit_price || 0),
    DetailType: 'SalesItemLineDetail',
    Description: [item.service_name, item.description].filter(Boolean).join(' — '),
    SalesItemLineDetail: {
      ItemRef: {
        value: item.quickbooks_item_id || '1',
        name:  item.quickbooks_item_name || item.service_name || 'Services'
      },
      Qty:       item.quantity  || 1,
      UnitPrice: item.unit_price || 0
    }
  }));

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
      value: invoice.quickbooks_customer_id || '1',
      name:  invoice.client_name || 'Customer'
    },
    BillEmail:     invoice.client_email   ? { Address: invoice.client_email } : undefined,
    BillAddr:      invoice.client_address ? { Line1: invoice.client_address } : undefined,
    CustomerMemo:  invoice.job_description ? { value: invoice.job_description } : undefined,
    PrivateNote:   invoice.notes || undefined,
    DueDate:       undefined
  };
}

// ── Create an invoice in QBO using a connection row ─────────────────────────
async function createQBOInvoice(invoice, connection) {
  if (!connection?.access_token || !connection?.realm_id) {
    throw new Error('QuickBooks connection is missing access_token or realm_id');
  }
  const baseUrl = getQBOBaseUrl();
  const payload = buildQBOInvoicePayload(invoice);

  const response = await axios.post(
    `${baseUrl}/${connection.realm_id}/invoice`,
    { Invoice: payload },
    {
      headers: {
        Authorization: `Bearer ${connection.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    }
  );

  const qboInvoice = response.data.Invoice;
  const envSuffix = process.env.INTUIT_ENVIRONMENT === 'production' ? '' : 'sandbox.';
  return {
    qbo_invoice_id:  qboInvoice.Id,
    qbo_invoice_num: qboInvoice.DocNumber,
    total:           qboInvoice.TotalAmt,
    status:          qboInvoice.EmailStatus || 'NotSet',
    view_url:        `https://app.${envSuffix}qbo.intuit.com/app/invoice?txnId=${qboInvoice.Id}`
  };
}

function isQBOConfigured() {
  return !!(
    process.env.INTUIT_CLIENT_ID &&
    process.env.INTUIT_CLIENT_SECRET &&
    process.env.INTUIT_REDIRECT_URI
  );
}

module.exports = {
  buildAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  buildQBOInvoicePayload,
  createQBOInvoice,
  getConnection,
  saveConnection,
  refreshIfNeeded,
  isQBOConfigured
};
