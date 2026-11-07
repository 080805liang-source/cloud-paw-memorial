const tcb = require('@cloudbase/node-sdk');
const crypto = require('crypto');
const https = require('https');
const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV });
const db = app.database();
const WEB_ORIGIN = 'https://080805liang-source.github.io';
const STATIC_ORIGIN = 'https://cloud-paw-vip-cn-d0eub7r110788a3-1460995143.tcloudbaseapp.com';
// 店主账号：固定保留，避免部署环境变量误配置导致管理员权限丢失。
const ADMIN_EMAILS = new Set([
  '3903345807@qq.com',
  ...String(process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
]);
const now = () => new Date().toISOString();
const ADMIN_EVENTS = 'cp_admin_events';
const FEEDBACK = 'cp_feedback';
const WORKSHOP = 'pf_workshop';
const WORKSHOP_UPLOADS = 'pf_workshop_uploads';
const random = () => crypto.randomBytes(32).toString('hex');
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const passwordHash = (password, salt) => crypto.pbkdf2Sync(String(password), salt, 100000, 32, 'sha256').toString('hex');
const isAllowedOrigin = (origin) => origin === 'null'
  || origin === WEB_ORIGIN
  || origin === STATIC_ORIGIN
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
const isAdmin = (user) => ADMIN_EMAILS.has(String(user?.email || '').trim().toLowerCase());
const hasMembership = (user) => Boolean(user?.vipExpiresAt && new Date(user.vipExpiresAt) > new Date());
const publicUser = (user) => ({ id: user._id, email: user.email || null, phone: user.phone || null, credits: Number(user.credits || 0), isAdmin: isAdmin(user), membershipActive: hasMembership(user), vipExpiresAt: user.vipExpiresAt || null });
const readyCollections = new Set();
async function ensureCollection(name) {
  if (readyCollections.has(name)) return;
  if (typeof db.createCollectionIfNotExists === 'function') await db.createCollectionIfNotExists(name);
  else if (typeof db.createCollection === 'function') {
    try { await db.createCollection(name); }
    catch (error) { if (!/exist|duplicate|409/i.test(`${error.code || ''} ${error.message || ''}`)) throw error; }
  } else throw new Error('数据库不支持创建集合。');
  readyCollections.add(name);
}
async function countWhere(collection, conditions = {}) {
  const result = await db.collection(collection).where(conditions).count();
  return Number(result.total ?? result.data?.total ?? 0);
}
function shanghaiDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function shanghaiDayStart(day) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date) - 8 * 60 * 60 * 1000).toISOString();
}
function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = String(email).split('@');
  return `${local.slice(0, Math.min(3, local.length))}***@${domain || ''}`;
}
function maskPhone(phone) { return phone ? `${String(phone).slice(0, 3)}****${String(phone).slice(-4)}` : ''; }
function adminUserSummary(user) {
  return { id: user._id, identity: user.email ? maskEmail(user.email) : maskPhone(user.phone), createdAt: user.createdAt || null, usageCount: Number(user.usageCount || 0), credits: Number(user.credits || 0), isAdmin: isAdmin(user), vipExpiresAt: user.vipExpiresAt || null, membershipActive: hasMembership(user) };
}
async function recordGeneration(user, workshopId = '') {
  await ensureCollection(ADMIN_EVENTS);
  if (workshopId) await ensureCollection(WORKSHOP);
  return db.runTransaction(async (transaction) => {
    if (workshopId) {
      const item = await transaction.collection(WORKSHOP).doc(workshopId).get();
      const post = Array.isArray(item.data) ? item.data[0] : item.data;
      if (!post?.isPublic) throw Object.assign(new Error('这个作品已取消分享。'), { status: 404 });
      await transaction.collection(WORKSHOP).doc(workshopId).update({ downloads: db.command.inc(1) });
    }
    const result = await transaction.collection('cp_users').doc(user._id).get();
    const current = Array.isArray(result.data) ? result.data[0] : result.data;
    const currentCredits = Number(current?.credits || 0);
    const unlimited = isAdmin(current) || hasMembership(current);
    if (!unlimited && currentCredits < 1) throw Object.assign(new Error('请先兑换会员码，再继续使用。'), { status: 403 });
    const credits = unlimited ? currentCredits : currentCredits - 1;
    await transaction.collection('cp_users').doc(user._id).update({ credits, usageCount: db.command.inc(1) });
    await transaction.collection(ADMIN_EVENTS).add({ type: 'generation', userId: user._id, day: shanghaiDay(), createdAt: now() });
    return credits;
  });
}

function workshopImage(value, maxBytes, maxSide) {
  if (typeof value !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > maxBytes * 1.4 + 32) throw Object.assign(new Error('作品图片需为透明 PNG，且不能超过大小限制。'), { status: 400 });
  const bytes = Buffer.from(value.slice(22), 'base64');
  if (bytes.length > maxBytes || bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') throw Object.assign(new Error('作品图片不是有效的 PNG。'), { status: 400 });
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > maxSide || height > maxSide) throw Object.assign(new Error('作品图片尺寸过大。'), { status: 400 });
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function workshopConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 32000) throw Object.assign(new Error('作品配置无效或过大。'), { status: 400 });
  const result = {};
  const fields = ['name','image','size','opacity','clickLine','status','clickAnimation','bubbleStyle','position','alwaysOnTop','desktopOnly','shadow','motionEnabled','hoverEffect','leaveEffect','idleBehavior','doubleClickEffect','cursorFollowMode','proactiveFrequency','keyboardReaction','wanderEnabled','hoverBubble','clickParticles','soundHint','keyboardSync','interactionNote','visualStyle'];
  for (const key of fields) {
    const value = input[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
  }
  for (const [key, min, max] of [['size',70,140],['opacity',72,100]]) if (!Number.isFinite(result[key]) || result[key] < min || result[key] > max) throw Object.assign(new Error('作品的大小或透明度配置无效。'), { status: 400 });
  if (!String(result.name || '').trim() || String(result.name).length > 80) throw Object.assign(new Error('请填写作品名称。'), { status: 400 });
  const shortcuts = input.customShortcuts || [];
  if (!Array.isArray(shortcuts) || shortcuts.length > 20) throw Object.assign(new Error('快捷入口最多 20 项。'), { status: 400 });
  result.customShortcuts = shortcuts.map((item) => {
    if (!item || !['file','folder','url','app'].includes(item.type) || typeof item.target !== 'string' || /^(?:javascript|data|vbscript):/i.test(item.target.trim())) throw Object.assign(new Error('作品包含无效的快捷入口。'), { status: 400 });
    const clean = {};
    for (const key of ['id','label','type','target','fallback']) if (typeof item[key] === 'string') clean[key] = item[key].slice(0, 1024);
    if (Array.isArray(item.appPaths)) clean.appPaths = item.appPaths.filter((path) => typeof path === 'string').slice(0, 10).map((path) => path.slice(0, 1024));
    return clean;
  });
  return { ...result, image: 'pet.png', safeRendering: false, targetFps: 120 };
}

function publicWorkshop(post, full = false) {
  return { id: post._id, authorId: post.userId, author: post.author, title: post.title, description: post.description || '', preview: post.preview, style: post.style || 'original', downloads: Number(post.downloads || 0), createdAt: post.createdAt,
    ...(full ? { image: post.image, imageSha256: post.imageSha256, config: post.config } : {}) };
}
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
const emailConfigReady = () => Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
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
function sendEmailCode(email, code) {
  if (!emailConfigReady()) throw new Error('邮箱验证码服务尚未配置，请先联系管理员。');
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [email],
      subject: 'PET FORGE 邮箱验证码',
      html: `<p>你的 PET FORGE 注册验证码是：</p><p style="font-size:28px;font-weight:700;letter-spacing:8px">${code}</p><p>验证码 10 分钟内有效。如非本人操作，请忽略此邮件。</p>`
    });
    const request = https.request({ hostname: 'api.resend.com', path: '/emails', method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${process.env.RESEND_API_KEY}`
    }}, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => { if (response.statusCode >= 200 && response.statusCode < 300) resolve(); else { try { reject(new Error(JSON.parse(data).message || '邮件服务返回错误。')); } catch (_) { reject(new Error('邮件服务返回错误。')); } } });
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
async function verifyEmailCode(email, code) {
  const record = await getOne('cp_email_codes', { email, codeHash: sha256(code) });
  if (!record || record.usedAt || new Date(record.expiresAt) <= new Date()) return false;
  await db.collection('cp_email_codes').doc(record._id).update({ usedAt: now() });
  return true;
}

exports.main = async (event) => {
  const method = String(event.httpMethod || 'GET').toUpperCase();
  const parsedUrl = new URL(String(event.path || '/'), 'https://petforge.invalid');
  const path = parsedUrl.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
  const query = event.queryStringParameters || Object.fromEntries(parsedUrl.searchParams);
  if (method === 'OPTIONS') return { statusCode: 204, headers: headers(event.headers?.origin || ''), body: '' };
  const origin = event.headers?.origin || '';
  if (origin && !isAllowedOrigin(origin)) return reply(event, { error: '来源不被允许。' }, 403);
  try {
    if (path === '/health') return reply(event, { ok: true, region: 'cn', release: 'workshop-20261107' });
    if (method === 'POST' && ['/orders', '/admin/confirm-order'].includes(path)) return reply(event, { error: '站内支付已关闭，请登录后兑换会员码。' }, 410);
    const body = readBody(event);
    if (method === 'GET' && path === '/workshop') {
      await ensureCollection(WORKSHOP);
      const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
      const limit = Math.min(12, Math.max(1, Math.floor(Number(query.limit) || 12)));
      const order = query.sort === 'popular' ? 'downloads' : 'createdAt';
      const posts = await db.collection(WORKSHOP).where({ isPublic: true }).field({ image: false, config: false }).orderBy(order, 'desc').skip(offset).limit(limit).get();
      return reply(event, { posts: posts.data.map((post) => publicWorkshop(post)), total: await countWhere(WORKSHOP, { isPublic: true }), offset, limit });
    }
    const workshopMatch = path.match(/^\/workshop\/([a-zA-Z0-9_-]{1,80})$/);
    if (method === 'GET' && workshopMatch) {
      await ensureCollection(WORKSHOP);
      const post = await getOne(WORKSHOP, { _id: workshopMatch[1], isPublic: true });
      return post ? reply(event, { post: publicWorkshop(post, true) }) : reply(event, { error: '这个作品不存在或已取消分享。' }, 404);
    }
    if (method === 'POST' && path === '/auth/send-code') {
      const phone = String(body.phone || '').trim();
      if (!phonePattern.test(phone)) return reply(event, { error: '手机号格式不正确。' }, 400);
      if (!smsConfigReady()) return reply(event, { error: '短信验证码服务尚未配置，请先联系管理员。' }, 503);
      const code = String(crypto.randomInt(100000, 1000000));
      try { await sendSmsCode(phone, code); } catch (error) { return reply(event, { error: `验证码发送失败：${error.message}` }, 502); }
      await db.collection('cp_sms_codes').add({ phone, codeHash: sha256(code), expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), createdAt: now() });
      return reply(event, { ok: true });
    }
    if (method === 'POST' && path === '/auth/send-email-code') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) return reply(event, { error: '邮箱格式不正确。' }, 400);
      if (!emailConfigReady()) return reply(event, { error: '邮箱验证码服务尚未配置，请先联系管理员。' }, 503);
      const code = String(crypto.randomInt(100000, 1000000));
      try { await sendEmailCode(email, code); } catch (error) { return reply(event, { error: `验证码发送失败：${error.message}` }, 502); }
      await db.collection('cp_email_codes').add({ email, codeHash: sha256(code), expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), createdAt: now() });
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
        if (await getOne('cp_users', { phone })) return reply(event, { error: '这个手机号已经注册，请直接登录。' }, 409);
        if (!await verifySmsCode(phone, String(body.smsCode || '').trim())) return reply(event, { error: '验证码错误或已过期。' }, 400);
      } else {
        if (!/^\S+@\S+\.\S+$/.test(email)) return reply(event, { error: '请填写有效邮箱。' }, 400);
        if (await getOne('cp_users', { email })) return reply(event, { error: '这个邮箱已经注册，请直接登录。' }, 409);
        if (!await verifyEmailCode(email, String(body.emailCode || '').trim())) return reply(event, { error: '邮箱验证码错误或已过期。' }, 400);
      }
      const salt = random();
      const added = await db.collection('cp_users').add({ email: identity === 'email' ? email : null, phone: identity === 'phone' ? phone : null, emailVerifiedAt: identity === 'email' ? now() : null, phoneVerifiedAt: identity === 'phone' ? now() : null, passwordHash: passwordHash(password, salt), passwordSalt: salt, credits: 0, createdAt: now() });
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
    if (method === 'POST' && path === '/analytics/pageview') {
      const page = String(body.page || '');
      if (!['home', 'creator', 'workshop', 'support'].includes(page)) return reply(event, { error: '页面参数无效。' }, 400);
      await ensureCollection(ADMIN_EVENTS);
      await db.collection(ADMIN_EVENTS).add({ type: 'page_view', page, day: shanghaiDay(), createdAt: now() });
      return reply(event, { ok: true }, 202);
    }
    if (method === 'POST' && path === '/auth/logout') {
      const token = String(event.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      if (token) { const old = await getOne('cp_sessions', { token }); if (old) await db.collection('cp_sessions').doc(old._id).remove(); }
      return reply(event, { ok: true });
    }
    const user = await sessionUser(event);
    if (!user) return reply(event, { error: '请先登录。' }, 401);
    if (method === 'POST' && path === '/workshop/upload') {
      const { uploadId, index, total, data } = body;
      if (!/^[a-f0-9]{32}$/.test(String(uploadId)) || !Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > 40 || index < 0 || index >= total || typeof data !== 'string' || !data.length || data.length > 24000) return reply(event, { error: '上传分片参数无效。' }, 400);
      await ensureCollection(WORKSHOP_UPLOADS);
      const id = sha256(`${user._id}:${uploadId}:${index}`);
      const old = await getOne(WORKSHOP_UPLOADS, { _id: id });
      if (old && (old.data !== data || old.total !== total)) return reply(event, { error: '上传内容不一致，请重新发布。' }, 400);
      if (!old) await db.collection(WORKSHOP_UPLOADS).add({ _id: id, userId: user._id, uploadId, index, total, data, createdAt: now() });
      return reply(event, { ok: true });
    }
    if (method === 'POST' && path === '/workshop') {
      let payload = body, chunks = [];
      if (body.uploadId) {
        if (!/^[a-f0-9]{32}$/.test(String(body.uploadId))) return reply(event, { error: '上传标识无效。' }, 400);
        await ensureCollection(WORKSHOP_UPLOADS);
        const result = await db.collection(WORKSHOP_UPLOADS).where({ userId: user._id, uploadId: body.uploadId }).limit(40).get();
        chunks = result.data.sort((a, b) => a.index - b.index);
        if (!chunks.length || chunks.length !== chunks[0].total || chunks.some((chunk, index) => chunk.index !== index || chunk.total !== chunks.length || Date.now() - new Date(chunk.createdAt).getTime() > 1800000)) return reply(event, { error: '图片上传未完成或已过期，请重新发布。' }, 400);
        try { payload = JSON.parse(chunks.map((chunk) => chunk.data).join('')); } catch (_) { return reply(event, { error: '上传内容不完整，请重试。' }, 400); }
      }
      const config = workshopConfig(payload.config);
      const image = workshopImage(payload.image, 512 * 1024, 1024);
      const preview = workshopImage(payload.preview, 128 * 1024, 256);
      const description = String(payload.description || '').trim().slice(0, 600);
      const contentHash = sha256(JSON.stringify([config, image, description]));
      await ensureCollection(WORKSHOP);
      const existing = await getOne(WORKSHOP, { userId: user._id, contentHash });
      if (existing) {
        if (!existing.isPublic) await db.collection(WORKSHOP).doc(existing._id).update({ isPublic: true });
        await Promise.all(chunks.map((chunk) => db.collection(WORKSHOP_UPLOADS).doc(chunk._id).remove()));
        return reply(event, { id: existing._id, duplicate: true }, 201);
      }
      const bytes = Buffer.from(image.slice(22), 'base64');
      const post = { userId: user._id, author: `创作者 ${user._id.slice(-6)}`, title: config.name, description, config, image, preview, imageSha256: crypto.createHash('sha256').update(bytes).digest('hex'), contentHash, style: config.visualStyle || 'original', downloads: 0, isPublic: true, createdAt: now() };
      const saved = await db.collection(WORKSHOP).add(post);
      await Promise.all(chunks.map((chunk) => db.collection(WORKSHOP_UPLOADS).doc(chunk._id).remove()));
      return reply(event, { id: saved.id || saved._id }, 201);
    }
    if (method === 'PUT' && workshopMatch) {
      const post = await getOne(WORKSHOP, { _id: workshopMatch[1] });
      if (!post) return reply(event, { error: '作品不存在。' }, 404);
      if (post.userId !== user._id && !isAdmin(user)) return reply(event, { error: '只能取消自己作品的分享。' }, 403);
      if (body.isPublic !== false) return reply(event, { error: '作品状态无效。' }, 400);
      await db.collection(WORKSHOP).doc(post._id).update({ isPublic: false });
      return reply(event, { ok: true });
    }
    if (method === 'GET' && path === '/me') return reply(event, { user: publicUser(user) });
    if (method === 'POST' && path === '/consume') {
      const amount = Number(body.amount) === 1 ? 1 : 0;
      if (!amount) return reply(event, { error: '使用次数参数无效。' }, 400);
      let credits;
      const workshopId = String(body.workshopId || '');
      if (workshopId && !/^[a-zA-Z0-9_-]{1,80}$/.test(workshopId)) return reply(event, { error: '作品参数无效。' }, 400);
      try { credits = await recordGeneration(user, workshopId); }
      catch (error) { if ([403,404].includes(error.status)) return reply(event, { error: error.message }, error.status); throw error; }
      return reply(event, { credits, unlimited: isAdmin(user) || hasMembership(user) });
    }
    if (method === 'POST' && path === '/feedback') {
      const category = String(body.category || '');
      const message = String(body.message || '').trim();
      const details = String(body.details || '').trim();
      if (!['bug', 'account', 'payment', 'idea', 'other'].includes(category)) return reply(event, { error: '请选择反馈类型。' }, 400);
      if (message.length < 8 || message.length > 3000 || details.length > 3000) return reply(event, { error: '问题描述需为 8–3000 字，补充步骤最多 3000 字。' }, 400);
      await ensureCollection(FEEDBACK);
      const saved = await db.collection(FEEDBACK).add({ userId: user._id, category, message, details, contact: user.email || user.phone || '', status: 'open', createdAt: now() });
      return reply(event, { ok: true, id: saved.id || saved._id }, 201);
    }
    if (method === 'GET' && path === '/admin/overview') {
      if (!isAdmin(user)) return reply(event, { error: '只有管理员可以查看运营数据。' }, 403);
      await Promise.all([ensureCollection(ADMIN_EVENTS), ensureCollection(FEEDBACK)]);
      const today = shanghaiDay();
      const todayStart = shanghaiDayStart(today);
      const [users, generations, pageViews, todayUsers, todayGenerations, todayPageViews, openFeedback, inProgressFeedback, activeUsers] = await Promise.all([
        countWhere('cp_users'), countWhere(ADMIN_EVENTS, { type: 'generation' }), countWhere(ADMIN_EVENTS, { type: 'page_view' }),
        countWhere('cp_users', { createdAt: db.command.gte(todayStart) }), countWhere(ADMIN_EVENTS, { type: 'generation', day: today }),
        countWhere(ADMIN_EVENTS, { type: 'page_view', day: today }), countWhere(FEEDBACK, { status: 'open' }), countWhere(FEEDBACK, { status: 'in_progress' }), countWhere('cp_users', { usageCount: db.command.gt(0) })
      ]);
      const days = Array.from({ length: 14 }, (_, index) => new Date(Date.now() - index * 86400000)).reverse().map((date) => shanghaiDay(date));
      const activityResult = await db.collection(ADMIN_EVENTS).aggregate().match({ day: db.command.gte(days[0]) }).group({ _id: { day: '$day', type: '$type' }, total: db.command.aggregate.sum(1) }).end();
      const activity = days.map((day) => ({ day, views: Number(activityResult.data?.find((item) => item._id.day === day && item._id.type === 'page_view')?.total || 0), generations: Number(activityResult.data?.find((item) => item._id.day === day && item._id.type === 'generation')?.total || 0) }));
      const pageTotals = await Promise.all(['home', 'creator', 'workshop', 'support'].map(async (page) => ({ page, views: await countWhere(ADMIN_EVENTS, { type: 'page_view', page }) })));
      return reply(event, { metrics: { users, activeUsers, generations, pageViews, openFeedback: openFeedback + inProgressFeedback, todayUsers, todayGenerations, todayPageViews }, activity, pageTotals });
    }
    if (method === 'GET' && path === '/admin/users') {
      if (!isAdmin(user)) return reply(event, { error: '只有管理员可以查看用户统计。' }, 403);
      const limit = Math.max(1, Math.min(50, Math.floor(Number(query.limit) || 20)));
      const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
      const [total, result] = await Promise.all([countWhere('cp_users'), db.collection('cp_users').orderBy('createdAt', 'desc').skip(offset).limit(limit).get()]);
      return reply(event, { total, users: (result.data || []).map(adminUserSummary), offset, limit });
    }
    if (method === 'GET' && path === '/admin/feedback') {
      if (!isAdmin(user)) return reply(event, { error: '只有管理员可以查看用户反馈。' }, 403);
      await ensureCollection(FEEDBACK);
      const status = String(query.status || 'all');
      const where = ['open', 'in_progress', 'resolved'].includes(status) ? { status } : {};
      const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
      const [total, result] = await Promise.all([countWhere(FEEDBACK, where), db.collection(FEEDBACK).where(where).orderBy('createdAt', 'desc').skip(offset).limit(20).get()]);
      return reply(event, { total, offset, limit: 20, feedback: (result.data || []).map((item) => ({ id: item._id, category: item.category, message: item.message, details: item.details, contact: item.contact, status: item.status, createdAt: item.createdAt })) });
    }
    const feedbackStatusMatch = path.match(/^\/admin\/feedback\/([^/]+)$/);
    if (method === 'PUT' && feedbackStatusMatch) {
      if (!isAdmin(user)) return reply(event, { error: '只有管理员可以更新反馈状态。' }, 403);
      const status = String(body.status || '');
      if (!['open', 'in_progress', 'resolved'].includes(status)) return reply(event, { error: '反馈状态无效。' }, 400);
      const id = decodeURIComponent(feedbackStatusMatch[1]);
      const feedback = await db.collection(FEEDBACK).doc(id).get();
      const feedbackRecord = Array.isArray(feedback.data) ? feedback.data[0] : feedback.data;
      if (!feedbackRecord) return reply(event, { error: '未找到这条反馈。' }, 404);
      await db.collection(FEEDBACK).doc(id).update({ status, updatedAt: now(), resolvedAt: status === 'resolved' ? now() : null });
      return reply(event, { ok: true, status });
    }
    if (method === 'POST' && path === '/redeem') {
      const input = String(body.code || '').trim().toUpperCase();
      if (!/^PAW-(?:[A-F0-9]{4}-){3,7}[A-F0-9]{4}$/.test(input)) return reply(event, { error: '会员码格式不正确，请检查后重试。' }, 400);
      await ensureCollection('cp_codes');
      const code = await getOne('cp_codes', { codeHash: sha256(input) });
      if (!code) return reply(event, { error: '会员码不存在、已使用或已停用。' }, 400);
      try {
        const updated = await db.runTransaction(async (transaction) => {
          const result = await transaction.collection('cp_codes').doc(code._id).get();
          const currentCode = Array.isArray(result.data) ? result.data[0] : result.data;
          if (!currentCode || currentCode.usedAt || currentCode.revokedAt || (currentCode.expiresAt && new Date(currentCode.expiresAt) <= new Date())) throw Object.assign(new Error('会员码不存在、已使用或已停用。'), { status: 400 });
          const ownerResult = await transaction.collection('cp_users').doc(user._id).get();
          const owner = Array.isArray(ownerResult.data) ? ownerResult.data[0] : ownerResult.data;
          const changes = currentCode.kind === 'credits' ? { credits: Number(owner.credits || 0) + Number(currentCode.credits || 3) } : { vipExpiresAt: plusDays(owner.vipExpiresAt, currentCode.durationDays || 30) };
          await transaction.collection('cp_users').doc(user._id).update(changes);
          await transaction.collection('cp_codes').doc(code._id).update({ usedAt: now(), usedBy: user._id });
          return { ...owner, ...changes };
        });
        return reply(event, { user: publicUser(updated), credits: Number(updated.credits || 0), vipExpiresAt: updated.vipExpiresAt || null });
      } catch (error) { if (error.status === 400) return reply(event, { error: error.message }, 400); throw error; }
    }
    if (method === 'POST' && path === '/admin/issue-code') {
      if (!isAdmin(user)) return reply(event, { error: '只有管理员可以生成会员码。' }, 403);
      const kind = String(body.kind || 'membership');
      const quantity = Number(body.quantity ?? 1);
      const durationDays = Number(body.durationDays || 30);
      if (kind !== 'membership' || !Number.isInteger(quantity) || quantity < 1 || quantity > 20 || ![30, 90].includes(durationDays)) return reply(event, { error: '请选择 30 天或 90 天会员，每批最多生成 20 个会员码。' }, 400);
      await ensureCollection('cp_codes');
      const codes = await db.runTransaction(async (transaction) => {
        const issued = [];
        for (let index = 0; index < quantity; index += 1) {
          const code = `PAW-${crypto.randomBytes(16).toString('hex').toUpperCase().match(/.{1,4}/g).join('-')}`;
          const saved = await transaction.collection('cp_codes').add({ codeHash: sha256(code), suffix: code.slice(-9), kind, durationDays, createdAt: now(), issuedBy: user._id });
          issued.push({ id: saved.id || saved._id, code, kind, durationDays });
        }
        return issued;
      });
      return reply(event, { codes, code: codes[0].code }, 201);
    }
    if (method === 'GET' && path === '/admin/codes') {
      if (!isAdmin(user)) return reply(event, { error: '只有管理员可以查看会员码。' }, 403);
      await ensureCollection('cp_codes');
      const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
      const [total, result] = await Promise.all([countWhere('cp_codes'), db.collection('cp_codes').orderBy('createdAt', 'desc').skip(offset).limit(20).get()]);
      return reply(event, { total, offset, limit: 20, codes: (result.data || []).map((code) => ({ id: code._id, label: code.suffix ? `••••-${code.suffix}` : '旧版会员码', kind: code.kind || 'membership', credits: code.credits || 0, durationDays: code.durationDays || 30, status: code.usedAt ? 'used' : code.revokedAt ? 'revoked' : 'unused', createdAt: code.createdAt, usedAt: code.usedAt || null })) });
    }
    const codeStatusMatch = path.match(/^\/admin\/codes\/([^/]+)$/);
    if (method === 'PUT' && codeStatusMatch) {
      if (!isAdmin(user)) return reply(event, { error: '只有管理员可以停用会员码。' }, 403);
      if (body.status !== 'revoked') return reply(event, { error: '会员码状态无效。' }, 400);
      try {
        await db.runTransaction(async (transaction) => {
          const ref = transaction.collection('cp_codes').doc(decodeURIComponent(codeStatusMatch[1]));
          const result = await ref.get();
          const code = Array.isArray(result.data) ? result.data[0] : result.data;
          if (!code) throw Object.assign(new Error('未找到会员码。'), { status: 404 });
          if (code.usedAt) throw Object.assign(new Error('已兑换的会员码不能停用。'), { status: 409 });
          await ref.update({ revokedAt: now(), revokedBy: user._id });
        });
        return reply(event, { ok: true });
      } catch (error) { if ([404, 409].includes(error.status)) return reply(event, { error: error.message }, error.status); throw error; }
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
    if (error.status === 400) return reply(event, { error: error.message }, 400);
    console.error(error);
    return reply(event, { error: '会员服务暂时繁忙，请稍后再试。' }, 500);
  }
};
