/**
 * Auth middleware
 *
 * Verifies a Supabase JWT from the `Authorization: Bearer <token>` header and
 * exposes:
 *   - req.userId            uuid of the authenticated user
 *   - req.accessToken       raw bearer token
 *   - req.supabase          user-scoped client (RLS enforced as that user)
 *   - req.supabaseAdmin     service-role client (bypasses RLS; use sparingly)
 *
 * Both clients are instantiated lazily and cached on the request to avoid
 * repeated handshake overhead.
 */

const { createClient } = require('@supabase/supabase-js');

let cachedAdmin = null;

function getAdminClient() {
  if (cachedAdmin) return cachedAdmin;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  cachedAdmin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return cachedAdmin;
}

function makeUserClient(accessToken) {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false }
    }
  );
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ success: false, error: 'Missing Authorization: Bearer <token>' });
    }
    const accessToken = match[1];

    const admin = getAdminClient();
    const { data, error } = await admin.auth.getUser(accessToken);
    if (error || !data?.user) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    req.userId = data.user.id;
    req.accessToken = accessToken;
    req.supabase = makeUserClient(accessToken);
    req.supabaseAdmin = admin;
    next();
  } catch (err) {
    console.error('[auth] Verification error:', err.message);
    res.status(500).json({ success: false, error: 'Auth verification failed' });
  }
}

module.exports = { requireAuth, getAdminClient, makeUserClient };
