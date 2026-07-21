const encoder = new TextEncoder();
const json = (body, status = 200, origin = '') => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors(origin) } });
const allowedOrigins = new Set([
  'https://080805liang-source.github.io',
  'https://petforge-studio-111.humble-map-0803.chatgpt.site',
  'http://localhost:8765',
  'http://localhost:8787'
]);
const cors = (origin) => ({ 'access-control-allow-origin': origin || 'https://080805liang-source.github.io', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', 'access-control-allow-headers': 'content-type, authorization', 'vary': 'Origin' });
const id = () => crypto.randomUUID();
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
const sha256 = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');
const getBody = async (request) => { try { return await request.json(); } catch (_) { return {}; } };

async function passwordHash(password, salt = token()) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return { salt, hash: Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, '0')).join('') };
}

async function userFromRequest(request, env) {
  const value = request.headers.get('authorization') || '';
  const sessionId = value.startsWith('Bearer ') ? value.slice(7) : '';
  if (!sessionId) return null;
  return env.DB.prepare('SELECT users.id, users.email, users.vip_expires_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ? AND sessions.expires_at > ?').bind(sessionId, new Date().toISOString()).first();
}

async function createSession(userId, env) {
  const sessionId = token();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(sessionId, userId, expires).run();
  return sessionId;
}

function publicUser(user) { return { id: user.id, email: user.email, vipExpiresAt: user.vip_expires_at }; }

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const allowed = allowedOrigins.has(origin);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(allowed ? origin : '') });
    if (origin && !allowed) return json({ error: '来源不被允许。' }, 403, '');
    const url = new URL(request.url);
    const reply = (body, status) => json(body, status, allowed ? origin : '');
    if (url.pathname === '/health') return reply({ ok: true });

    if (request.method === 'POST' && url.pathname === '/auth/signup') {
      const { email = '', password = '' } = await getBody(request);
      const normalized = String(email).trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(normalized) || String(password).length < 8) return reply({ error: '请填写有效邮箱，密码至少 8 位。' }, 400);
      const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(normalized).first();
      if (existing) return reply({ error: '这个邮箱已经注册，请直接登录。' }, 409);
      const secured = await passwordHash(String(password)); const user = { id: id(), email: normalized, vip_expires_at: null };
      await env.DB.prepare('INSERT INTO users (id, email, password_hash, password_salt) VALUES (?, ?, ?, ?)').bind(user.id, user.email, secured.hash, secured.salt).run();
      return reply({ token: await createSession(user.id, env), user: publicUser(user) }, 201);
    }

    if (request.method === 'POST' && url.pathname === '/auth/login') {
      const { email = '', password = '' } = await getBody(request); const normalized = String(email).trim().toLowerCase();
      const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(normalized).first();
      if (!user) return reply({ error: '邮箱或密码不正确。' }, 401);
      const secured = await passwordHash(String(password), user.password_salt);
      if (secured.hash !== user.password_hash) return reply({ error: '邮箱或密码不正确。' }, 401);
      return reply({ token: await createSession(user.id, env), user: publicUser(user) });
    }

    if (request.method === 'POST' && url.pathname === '/auth/logout') {
      const sessionId = (request.headers.get('authorization') || '').replace('Bearer ', '');
      if (sessionId) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
      return reply({ ok: true });
    }

    const user = await userFromRequest(request, env);
    if (!user) return reply({ error: '请先登录。' }, 401);
    if (request.method === 'GET' && url.pathname === '/me') return reply({ user: publicUser(user) });

    if (request.method === 'POST' && url.pathname === '/redeem') {
      const { code = '' } = await getBody(request); const hash = await sha256(String(code).trim().toUpperCase());
      const voucher = await env.DB.prepare('SELECT * FROM redeem_codes WHERE code_hash = ?').bind(hash).first();
      if (!voucher || voucher.used_by) return reply({ error: '兑换码不存在或已被使用。' }, 400);
      const start = user.vip_expires_at && new Date(user.vip_expires_at) > new Date() ? new Date(user.vip_expires_at) : new Date();
      const expires = new Date(start.getTime() + voucher.duration_days * 86400000).toISOString();
      await env.DB.batch([
        env.DB.prepare('UPDATE redeem_codes SET used_by = ?, used_at = ? WHERE id = ? AND used_by IS NULL').bind(user.id, new Date().toISOString(), voucher.id),
        env.DB.prepare('UPDATE users SET vip_expires_at = ? WHERE id = ?').bind(expires, user.id)
      ]);
      return reply({ vipExpiresAt: expires });
    }

    if (url.pathname === '/memorial' && request.method === 'GET') {
      const row = await env.DB.prepare('SELECT data_json, updated_at FROM memorials WHERE user_id = ?').bind(user.id).first();
      return reply({ memorial: row ? JSON.parse(row.data_json) : null, updatedAt: row?.updated_at || null });
    }
    if (url.pathname === '/memorial' && request.method === 'PUT') {
      const { memorial } = await getBody(request);
      if (!memorial || typeof memorial !== 'object') return reply({ error: '纪念资料格式不正确。' }, 400);
      const now = new Date().toISOString();
      await env.DB.prepare('INSERT INTO memorials (id, user_id, data_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at').bind(id(), user.id, JSON.stringify(memorial), now).run();
      return reply({ ok: true, updatedAt: now });
    }
    return reply({ error: '没有找到这个功能。' }, 404);
  }
};
