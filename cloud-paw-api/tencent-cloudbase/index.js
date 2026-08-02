const tcb = require('@cloudbase/node-sdk');
const crypto = require('crypto');
const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV });
const db = app.database();
const WEB_ORIGIN = 'https://080805liang-source.github.io';
// 店主账号：无需兑换码，可进入管理员发卡区。
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '3903345807@qq.com').trim().toLowerCase();
const now = () => new Date().toISOString();
const random = () => crypto.randomBytes(32).toString('hex');
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const passwordHash = (password, salt) => crypto.pbkdf2Sync(String(password), salt, 100000, 32, 'sha256').toString('hex');
const isAllowedOrigin = (origin) => origin === 'null' || origin === WEB_ORIGIN || /^https:\/\/cloud-paw-vip-cn-d0eub7r110788a3(?:-[a-z0-9]+)?(?:\.ap-shanghai)?\.(?:app\.tcloudbase\.com|tcloudbaseapp\.com)$/i.test(origin);
const headers = (origin) => ({
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': isAllowedOrigin(origin) ? origin : WEB_ORIGIN,
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization'
});
const reply = (event, body, statusCode = 200) => ({ statusCode, headers: headers(event.headers?.origin || ''), body: JSON.stringify(body) });
const getOne = async (collection, where) => {
  const result = await db.collection(collection).where(where).limit(1).get();
  return result.data?.[0] || null;
};
const readBody = (event) => { try { return JSON.parse(event.body || '{}'); } catch (_) { return {}; } };
const isAdmin = (user) => String(user?.email || '').trim().toLowerCase() === ADMIN_EMAIL;
const publicUser = (user) => ({ id: user._id, email: user.email, vipExpiresAt: user.vipExpiresAt || null, isAdmin: isAdmin(user) });
const plusDays = (oldExpiry, days) => {
  const base = oldExpiry && new Date(oldExpiry) > new Date() ? new Date(oldExpiry) : new Date();
  base.setDate(base.getDate() + Number(days));
  return base.toISOString();
};

async function sessionUser(event) {
  const token = String(event.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const session = await getOne('cp_sessions', { token });
  if (!session || new Date(session.expiresAt) <= new Date()) return null;
  return getOne('cp_users', { _id: session.userId });
}
async function createSession(userId) {
  const token = random();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await db.collection('cp_sessions').add({ userId, token, expiresAt, createdAt: now() });
  return token;
}

exports.main = async (event) => {
  const method = String(event.httpMethod || 'GET').toUpperCase();
  const path = String(event.path || '/').replace(/^\/api/, '') || '/';
  if (method === 'OPTIONS') return { statusCode: 204, headers: headers(event.headers?.origin || ''), body: '' };
  const origin = event.headers?.origin || '';
  if (origin && !isAllowedOrigin(origin)) return reply(event, { error: '来源不被允许。' }, 403);
  try {
    if (path === '/health') return reply(event, { ok: true, region: 'cn' });
    const body = readBody(event);
    if (method === 'POST' && path === '/auth/signup') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return reply(event, { error: '请填写有效邮箱，密码至少 8 位。' }, 400);
      if (await getOne('cp_users', { email })) return reply(event, { error: '这个邮箱已经注册，请直接登录。' }, 409);
      const salt = random();
      const added = await db.collection('cp_users').add({ email, passwordHash: passwordHash(password, salt), passwordSalt: salt, vipExpiresAt: null, createdAt: now() });
      const user = { _id: added.id || added._id, email, vipExpiresAt: null };
      return reply(event, { token: await createSession(user._id), user: publicUser(user) }, 201);
    }
    if (method === 'POST' && path === '/auth/login') {
      const email = String(body.email || '').trim().toLowerCase();
      const user = await getOne('cp_users', { email });
      if (!user || passwordHash(body.password || '', user.passwordSalt) !== user.passwordHash) return reply(event, { error: '邮箱或密码不正确。' }, 401);
      return reply(event, { token: await createSession(user._id), user: publicUser(user) });
    }
    if (method === 'POST' && path === '/auth/logout') {
      const token = String(event.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      if (token) { const old = await getOne('cp_sessions', { token }); if (old) await db.collection('cp_sessions').doc(old._id).remove(); }
      return reply(event, { ok: true });
    }
    const user = await sessionUser(event);
    if (!user) return reply(event, { error: '请先登录。' }, 401);
    if (method === 'GET' && path === '/me') return reply(event, { user: publicUser(user) });
    if (method === 'POST' && path === '/redeem') {
      const codeHash = sha256(String(body.code || '').trim().toUpperCase());
      const code = await getOne('cp_codes', { codeHash });
      if (!code || code.usedAt) return reply(event, { error: '兑换码不存在、已使用或已失效。' }, 400);
      const vipExpiresAt = plusDays(user.vipExpiresAt, code.durationDays || 30);
      await db.collection('cp_codes').doc(code._id).update({ usedAt: now(), usedBy: user._id });
      await db.collection('cp_users').doc(user._id).update({ vipExpiresAt });
      return reply(event, { vipExpiresAt });
    }
    if (method === 'POST' && path === '/admin/issue-code') {
      if (!isAdmin(user)) return reply(event, { error: '只有管理员账号可以发卡。' }, 403);
      const durationDays = Number(body.durationDays) === 90 ? 90 : 30;
      const code = `PAW-${crypto.randomBytes(8).toString('hex').toUpperCase().match(/.{1,4}/g).join('-')}`;
      await db.collection('cp_codes').add({
        codeHash: sha256(code),
        durationDays,
        createdAt: now(),
        issuedBy: user._id
      });
      return reply(event, { code, durationDays }, 201);
    }
    if (method === 'POST' && path === '/pet-license') {
      if (!isAdmin(user) && (!user.vipExpiresAt || new Date(user.vipExpiresAt) <= new Date())) {
        return reply(event, { error: '请先兑换有效 VIP，再生成桌面宠物。' }, 403);
      }
      const fingerprint = String(body.fingerprint || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
        return reply(event, { error: '桌面宠物文件校验失败，请重新生成。' }, 400);
      }
      const existing = await getOne('cp_desktop_licenses', { userId: user._id, fingerprint });
      if (existing) return reply(event, { licenseId: existing.licenseId, vipExpiresAt: user.vipExpiresAt });
      const licenseId = `pet_${random()}`;
      await db.collection('cp_desktop_licenses').add({
        licenseId,
        userId: user._id,
        fingerprint,
        deviceHash: null,
        createdAt: now()
      });
      return reply(event, { licenseId, vipExpiresAt: user.vipExpiresAt }, 201);
    }
    if (method === 'POST' && path === '/pet-license/verify') {
      const licenseId = String(body.licenseId || '');
      const fingerprint = String(body.fingerprint || '').toLowerCase();
      const deviceHash = String(body.deviceHash || '').toLowerCase();
      if (!licenseId || !/^[a-f0-9]{64}$/.test(fingerprint) || !/^[a-f0-9]{64}$/.test(deviceHash)) {
        return reply(event, { active: false, error: '桌面宠物授权信息无效。' }, 400);
      }
      const license = await getOne('cp_desktop_licenses', { licenseId });
      if (!license || license.fingerprint !== fingerprint || (license.deviceHash && license.deviceHash !== deviceHash)) {
        return reply(event, { active: false }, 403);
      }
      const owner = await getOne('cp_users', { _id: license.userId });
      if (!owner || (!isAdmin(owner) && (!owner.vipExpiresAt || new Date(owner.vipExpiresAt) <= new Date()))) return reply(event, { active: false }, 403);
      if (!license.deviceHash) await db.collection('cp_desktop_licenses').doc(license._id).update({ deviceHash, activatedAt: now() });
      return reply(event, { active: true, vipExpiresAt: owner.vipExpiresAt });
    }
    if (path === '/memorial' && method === 'GET') {
      const memorial = await getOne('cp_memorials', { userId: user._id });
      return reply(event, { memorial: memorial?.data || null });
    }
    if (path === '/memorial' && method === 'PUT') {
      const old = await getOne('cp_memorials', { userId: user._id });
      if (old) await db.collection('cp_memorials').doc(old._id).update({ data: body.memorial || {}, updatedAt: now() });
      else await db.collection('cp_memorials').add({ userId: user._id, data: body.memorial || {}, updatedAt: now() });
      return reply(event, { ok: true });
    }
    return reply(event, { error: '接口不存在。' }, 404);
  } catch (error) {
    console.error(error);
    return reply(event, { error: '会员服务暂时繁忙，请稍后再试。' }, 500);
  }
};
