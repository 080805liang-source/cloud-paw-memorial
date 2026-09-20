const tcb = require('@cloudbase/node-sdk');
const crypto = require('crypto');
const https = require('https');
const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV });
const db = app.database();
const WEB_ORIGIN = 'https://080805liang-source.github.io';
// 店主账号：可确认支付宝订单并直接测试。
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '3903345807@qq.com').trim().toLowerCase();
const now = () => new Date().toISOString();
const random = () => crypto.randomBytes(32).toString('hex');
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const passwordHash = (password, salt) => crypto.pbkdf2Sync(String(password), salt, 100000, 32, 'sha256').toString('hex');
const isAllowedOrigin = (origin) => origin === 'null'
  || origin === WEB_ORIGIN
  || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)
  || /^https:\/\/cloud-paw-vip-cn-d0eub7r110788a3(?:-[a-z0-9]+)?(?:\.ap-shanghai)?\.(?:app\.tcloudbase\.com|tcloudbaseapp\.com)$/i.test(origin);
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
const publicUser = (user) => ({ id: user._id, email: user.email || null, phone: user.phone || null, credits: Number(user.credits || 0), isAdmin: isAdmin(user) });
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
const phonePattern = /^1\d{10}$/;
const smsConfigReady = () => Boolean(process.env.TENCENTCLOUD_SECRET_ID && process.env.TENCENTCLOUD_SECRET_KEY && process.env.SMS_SDK_APP_ID && process.env.SMS_SIGN_NAME && process.env.SMS_TEMPLATE_ID);
function tencentSmsSignature(payload, timestamp) {
  const host = 'sms.tencentcloudapi.com';
  const service = 'sms';
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const hashedPayload = crypto.createHash('sha256').update(payload).digest('hex');
  const canonical = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = `POST\n/\n\n${canonical}\n${signedHeaders}\n${hashedPayload}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const secretDate = crypto.createHmac('sha256', `TC3${process.env.TENCENTCLOUD_SECRET_KEY}`).update(date).digest();
  const secretService = crypto.createHmac('sha256', secretDate).update(service).digest();
  const secretSigning = crypto.createHmac('sha256', secretService).update('tc3_request').digest();
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
  return `TC3-HMAC-SHA256 Credential=${process.env.TENCENTCLOUD_SECRET_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
function sendSmsCode(phone, code) {
  if (!smsConfigReady()) throw new Error('短信服务尚未配置，请先完成腾讯云短信配置。');
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      PhoneNumberSet: [`+86${phone}`],
      SmsSdkAppId: process.env.SMS_SDK_APP_ID,
      SignName: process.env.SMS_SIGN_NAME,
      TemplateId: process.env.SMS_TEMPLATE_ID,
      TemplateParamSet: [code, '10']
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const request = https.request({ hostname: 'sms.tencentcloudapi.com', path: '/', method: 'POST', headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'X-TC-Action': 'SendSms', 'X-TC-Version': '2021-01-11', 'X-TC-Region': process.env.SMS_REGION || 'ap-guangzhou',
      'X-TC-Timestamp': String(timestamp), 'X-TC-Language': 'zh-CN', Authorization: tencentSmsSignature(payload, timestamp)
    }}, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => { try { const result = JSON.parse(data); if (result.Response?.Error) reject(new Error(result.Response.Error.Message)); else resolve(); } catch (_) { reject(new Error('短信服务返回无效响应。')); } });
    });
    request.on('error', reject); request.write(payload); request.end();
  });
}
async function verifySmsCode(phone, code) {
  const record = await getOne('cp_sms_codes', { phone, codeHash: sha256(code) });
  if (!record || record.usedAt || new Date(record.expiresAt) <= new Date()) return false;
  await db.collection('cp_sms_codes').doc(record._id).update({ usedAt: now() });
  return true;
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
    if (method === 'POST' && path === '/auth/send-code') {
      const phone = String(body.phone || '').trim();
      if (!phonePattern.test(phone)) return reply(event, { error: '手机号格式不正确。' }, 400);
      if (!smsConfigReady()) return reply(event, { error: '短信验证码服务尚未配置，请先联系管理员。' }, 503);
      const code = String(crypto.randomInt(100000, 1000000));
      try { await sendSmsCode(phone, code); } catch (error) { return reply(event, { error: `验证码发送失败：${error.message}` }, 502); }
      await db.collection('cp_sms_codes').add({ phone, codeHash: sha256(code), expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), createdAt: now() });
      return reply(event, { ok: true });
    }
    if (method === 'POST' && path === '/auth/signup') {
      const identity = String(body.identity || 'email');
      const email = String(body.email || '').trim().toLowerCase();
      const phone = String(body.phone || '').trim();
      const password = String(body.password || '');
      if (password.length < 8 || password !== String(body.confirmPassword || '')) return reply(event, { error: '密码至少 8 位，且两次输入必须一致。' }, 400);
      if (identity === 'phone') {
        if (!phonePattern.test(phone)) return reply(event, { error: '请输入有效手机号。' }, 400);
        if (!await verifySmsCode(phone, String(body.smsCode || '').trim())) return reply(event, { error: '验证码错误或已过期。' }, 400);
        if (await getOne('cp_users', { phone })) return reply(event, { error: '这个手机号已经注册，请直接登录。' }, 409);
      } else {
        if (!/^\S+@\S+\.\S+$/.test(email)) return reply(event, { error: '请填写有效邮箱。' }, 400);
        if (await getOne('cp_users', { email })) return reply(event, { error: '这个邮箱已经注册，请直接登录。' }, 409);
      }
      const salt = random();
      const added = await db.collection('cp_users').add({ email: identity === 'email' ? email : null, phone: identity === 'phone' ? phone : null, passwordHash: passwordHash(password, salt), passwordSalt: salt, credits: 0, createdAt: now() });
      const user = { _id: added.id || added._id, email, phone, credits: 0 };
      return reply(event, { token: await createSession(user._id), user: publicUser(user) }, 201);
    }
    if (method === 'POST' && path === '/auth/login') {
      const identity = String(body.identity || 'email');
      const email = String(body.email || '').trim().toLowerCase();
      const phone = String(body.phone || '').trim();
      const user = await getOne('cp_users', identity === 'phone' ? { phone } : { email });
      if (!user || passwordHash(body.password || '', user.passwordSalt) !== user.passwordHash) return reply(event, { error: '账号或密码不正确。' }, 401);
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
    if (method === 'POST' && path === '/consume') {
      if (isAdmin(user)) return reply(event, { credits: Number(user.credits || 0) });
      const amount = Number(body.amount) === 1 ? 1 : 0;
      const currentCredits = Number(user.credits || 0);
      if (!amount || currentCredits < amount) return reply(event, { error: '可用次数不足，请先购买次数。' }, 403);
      const credits = currentCredits - amount;
      await db.collection('cp_users').doc(user._id).update({ credits });
      return reply(event, { credits });
    }
    if (method === 'POST' && path === '/orders') {
      if (String(body.product || '') !== 'credits_3' || Number(body.amount) !== 9.9) return reply(event, { error: '购买项目无效。' }, 400);
      const orderId = `PF${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const order = { orderId, userId: user._id, product: 'credits_3', amount: 9.9, credits: 3, status: 'pending', createdAt: now() };
      await db.collection('cp_orders').add(order);
      return reply(event, { order: { orderId, amount: order.amount, credits: order.credits, status: order.status } }, 201);
    }
    if (method === 'POST' && path === '/admin/confirm-order') {
      if (!isAdmin(user)) return reply(event, { error: '只有管理员可以确认订单。' }, 403);
      const orderId = String(body.orderId || '').trim();
      const order = await getOne('cp_orders', { orderId });
      if (!order || order.status !== 'pending') return reply(event, { error: '订单不存在或已经处理。' }, 400);
      const buyer = await getOne('cp_users', { _id: order.userId });
      if (!buyer) return reply(event, { error: '订单用户不存在。' }, 400);
      const creditsAdded = Number(order.credits || 3);
      await db.collection('cp_users').doc(buyer._id).update({ credits: Number(buyer.credits || 0) + creditsAdded });
      await db.collection('cp_orders').doc(order._id).update({ status: 'paid', confirmedAt: now(), confirmedBy: user._id });
      return reply(event, { orderId, creditsAdded, status: 'paid' });
    }
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
