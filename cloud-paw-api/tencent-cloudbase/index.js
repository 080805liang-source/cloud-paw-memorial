const tcb = require('@cloudbase/node-sdk');
const crypto = require('crypto');
const https = require('https');
const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV });
const db = app.database();
const WEB_ORIGIN = 'https://080805liang-source.github.io';
const STATIC_ORIGIN = 'https://cloud-paw-vip-cn-d0eub7r110788a3-1460995143.tcloudbaseapp.com';
const PUBLIC_ORIGIN = 'https://petforge-desktop.pages.dev';
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
const PASSWORD_ITERATIONS = 600000;
const passwordHash = (password, salt, iterations = PASSWORD_ITERATIONS) => new Promise((resolve, reject) => crypto.pbkdf2(password, salt, iterations, 32, 'sha256', (error, result) => error ? reject(error) : resolve(result.toString('hex'))));
const securityError = (message, status = 400) => Object.assign(new Error(message), { status, safe: true });
const isAllowedOrigin = (origin) => [WEB_ORIGIN, STATIC_ORIGIN, PUBLIC_ORIGIN, 'https://cloud-paw-vip-cn-d0eub7r110788a3-1460995143.ap-shanghai.app.tcloudbase.com'].includes(origin)
  || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin);
const headers = (origin) => ({
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': isAllowedOrigin(origin) ? origin : WEB_ORIGIN,
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'cache-control': 'no-store', 'pragma': 'no-cache', 'vary': 'Origin',
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer'
});
const reply = (event, body, statusCode = 200) => ({ statusCode, headers: { ...headers(event.headers?.origin || ''), ...(statusCode === 429 ? { 'retry-after': '60' } : {}) }, body: JSON.stringify(body) });
const getOne = async (collection, where) => {
  const result = await db.collection(collection).where(where).limit(1).get();
  return result.data?.[0] || null;
};
const readBody = (event) => {
  const raw = String(event.body || '{}');
  if (event.isBase64Encoded || Buffer.byteLength(raw) > 900000) throw securityError('请求内容过大或格式不受支持。', 413);
  let body;
  try { body = JSON.parse(raw, (key, value) => { if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('unsafe key'); return value; }); }
  catch (_) { throw securityError('请求需为有效的 JSON 对象。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw securityError('请求需为有效的 JSON 对象。');
  for (const key of ['email','phone','identity','password','confirmPassword','emailCode','challengeId','code']) if (body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > 256)) throw securityError('账号信息格式无效或过长。');
  return body;
};
const RATE_LIMITS = 'cp_rate_limits';
const clientAddress = (event) => String(event.requestContext?.sourceIp || event.requestContext?.http?.sourceIp || event.clientIP || 'unknown').slice(0, 80);
async function limitRequests(scope, actor, limit, milliseconds) {
  await ensureCollection(RATE_LIMITS);
  const id = sha256(`${scope}:${actor}`);
  const allowed = await db.runTransaction(async (transaction) => {
    const result = await transaction.collection(RATE_LIMITS).doc(id).get();
    const previous = Array.isArray(result.data) ? result.data[0] : result.data;
    const active = previous && Date.parse(previous.expiresAt) > Date.now();
    if (active && previous.count >= limit) return false;
    const data = { count: active ? previous.count + 1 : 1, expiresAt: active ? previous.expiresAt : new Date(Date.now() + milliseconds).toISOString() };
    if (previous) await transaction.collection(RATE_LIMITS).doc(id).update(data);
    else await transaction.collection(RATE_LIMITS).add({ _id: id, ...data });
    return true;
  });
  if (!allowed) throw securityError('操作过于频繁，请稍后重试。', 429);
}
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

const SHARED_APPS = {"snssdk1128://":{"label":"打开抖音","type":"app","target":"snssdk1128://","fallback":"https://www.douyin.com/","appPaths":["%LocalAppData%\\Douyin\\Douyin.exe","%ProgramFiles%\\Douyin\\Douyin.exe"]},"bilibili://":{"label":"打开哔哩哔哩","type":"app","target":"bilibili://","fallback":"https://www.bilibili.com/","appPaths":["%LocalAppData%\\Programs\\bilibili\\bilibili.exe","%ProgramFiles%\\bilibili\\bilibili.exe"]},"tencent://":{"label":"打开 QQ","type":"app","target":"tencent://","fallback":"https://im.qq.com/","appPaths":["%ProgramFiles%\\Tencent\\QQNT\\QQ.exe","%ProgramFiles(x86)%\\Tencent\\QQNT\\QQ.exe","%ProgramFiles%\\Tencent\\QQ\\QQ.exe","%ProgramFiles(x86)%\\Tencent\\QQ\\QQ.exe","%LocalAppData%\\Tencent\\QQ\\QQ.exe"]},"weixin://":{"label":"打开微信","type":"app","target":"weixin://","fallback":"https://weixin.qq.com/","appPaths":["%ProgramFiles%\\Tencent\\WeChat\\WeChat.exe","%ProgramFiles(x86)%\\Tencent\\WeChat\\WeChat.exe","%LocalAppData%\\Tencent\\WeChat\\WeChat.exe"]},"feishu://":{"label":"打开飞书","type":"app","target":"feishu://","fallback":"https://www.feishu.cn/","appPaths":["%LocalAppData%\\Programs\\Feishu\\Feishu.exe","%LocalAppData%\\Feishu\\Feishu.exe","%ProgramFiles%\\Feishu\\Feishu.exe"]},"dingtalk://":{"label":"打开钉钉","type":"app","target":"dingtalk://","fallback":"https://www.dingtalk.com/","appPaths":["%LocalAppData%\\DingTalk\\DingTalk.exe","%ProgramFiles(x86)%\\DingDing\\DingTalk.exe","%ProgramFiles%\\DingDing\\DingTalk.exe"]},"wxwork://":{"label":"打开企业微信","type":"app","target":"wxwork://","fallback":"https://work.weixin.qq.com/","appPaths":["%ProgramFiles%\\Tencent\\WeChat\\WXWork\\WXWork.exe","%ProgramFiles(x86)%\\Tencent\\WeChat\\WXWork\\WXWork.exe"]},"wps://":{"label":"打开 WPS Office","type":"app","target":"wps://","fallback":"https://www.wps.cn/","appPaths":["%ProgramFiles%\\kingsoft\\WPS Office\\ksolaunch.exe","%ProgramFiles(x86)%\\kingsoft\\WPS Office\\ksolaunch.exe"]},"steam://open/main":{"label":"打开 Steam","type":"app","target":"steam://open/main","fallback":"https://store.steampowered.com/","appPaths":["%ProgramFiles(x86)%\\Steam\\steam.exe","%ProgramFiles%\\Steam\\steam.exe"]},"com.epicgames.launcher://apps":{"label":"打开 Epic Games","type":"app","target":"com.epicgames.launcher://apps","fallback":"https://store.epicgames.com/","appPaths":["%ProgramFiles%\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe","%ProgramFiles(x86)%\\Epic Games\\Launcher\\Portal\\Binaries\\Win32\\EpicGamesLauncher.exe"]},"orpheus://":{"label":"打开网易云音乐","type":"app","target":"orpheus://","fallback":"https://music.163.com/","appPaths":["%ProgramFiles%\\Netease\\CloudMusic\\cloudmusic.exe","%ProgramFiles(x86)%\\Netease\\CloudMusic\\cloudmusic.exe"]},"vscode://":{"label":"打开 VS Code","type":"app","target":"vscode://","fallback":"https://code.visualstudio.com/","appPaths":["%LocalAppData%\\Programs\\Microsoft VS Code\\Code.exe","%ProgramFiles%\\Microsoft VS Code\\Code.exe"]},"discord://":{"label":"打开 Discord","type":"app","target":"discord://","fallback":"https://discord.com/app","appPaths":["%LocalAppData%\\Discord\\Update.exe"]}};
function sharedShortcut(item) {
  if (!item || typeof item.target !== 'string' || /[\x00-\x20\x7f]/.test(item.target)) throw securityError('公开作品的快捷入口仅支持 HTTPS 网页或内置常用软件。');
  const label = String(item.label || '').slice(0, 80);
  if (item.type === 'url') {
    let url; try { url = new URL(item.target); } catch (_) { throw securityError('快捷网址无效。'); }
    if (url.protocol !== 'https:' || url.username || url.password || item.target.length > 1024) throw securityError('公开作品的快捷网址必须使用 HTTPS。');
    return { label, type: 'url', target: url.href };
  }
  const preset = item.type === 'app' && Object.hasOwn(SHARED_APPS, item.target) && SHARED_APPS[item.target];
  if (!preset) throw securityError('公开作品的快捷入口仅支持 HTTPS 网页或内置常用软件。');
  return { ...preset, label: label || preset.label };
}

function sharedChat(input) {
  const appearance=input?.appearance || {};
  const result={theme:/^(glass|desktop|pixel|comic|paper|retro|outline|stitch|frame|candy)-[1-5]$/.test(appearance.theme)?appearance.theme:'glass-1',title:String(appearance.title||'和桌宠聊聊').slice(0,32),width:Math.max(300,Math.min(560,Number(appearance.width)||380)),fontSize:Math.max(12,Math.min(20,Number(appearance.fontSize)||14))};
  for(const field of ['accent','background']) if(/^#[0-9a-f]{6}$/i.test(appearance[field]||''))result[field]=appearance[field];
  // Public templates carry appearance only. Never inherit another author's credentials or endpoint.
  return {mode:'basic',appearance:result};
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
  result.customShortcuts = shortcuts.map(sharedShortcut);
  result.chat = sharedChat(input.chat);
  if (/^animal-\d{1,12}$/.test(input.animationPreset || '')) result.animationPreset = input.animationPreset;
  if (typeof input.assetAttribution === 'string') result.assetAttribution = input.assetAttribution.slice(0,8000);
  return { ...result, image: 'pet.png', safeRendering: false, targetFps: 120 };
}

function publicWorkshop(post, full = false) {
  return { id: post._id, authorId: post.userId, author: post.author, title: post.title, description: post.description || '', preview: post.preview, category: post.category || 'community', animated: post.animated === true, curated: post.curated === true, shortcutCount: post.config?.customShortcuts?.length || post.shortcutCount || 0, style: post.style || 'original', downloads: Number(post.downloads || 0), createdAt: post.createdAt,
    ...(full ? { image: post.image, imageSha256: post.imageSha256, config: { ...post.config, chat:sharedChat(post.config?.chat), customShortcuts: (post.config?.customShortcuts || []).flatMap((item) => { try { return [sharedShortcut(item)]; } catch (_) { return []; } }) } } : {}) };
}
const plusDays = (oldExpiry, days) => {
  const base = oldExpiry && new Date(oldExpiry) > new Date() ? new Date(oldExpiry) : new Date();
  base.setDate(base.getDate() + Number(days));
  return base.toISOString();
};

function bearerToken(event) {
  return /^Bearer ([a-zA-Z0-9_-]{1,256})$/.exec(String(event.headers?.authorization || ''))?.[1] || '';
}
async function findSession(token) {
  return token ? await getOne('cp_sessions', { tokenHash: sha256(token) }) || await getOne('cp_sessions', { token }) : null;
}
async function sessionUser(event) {
  const token = bearerToken(event);
  const session = await findSession(token);
  if (!session || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) return null;
  if (!session.tokenHash) await db.collection('cp_sessions').doc(session._id).update({ tokenHash: sha256(token), token: '' });
  const user = await getOne('cp_users', { _id: session.userId });
  return user && (session.authVersion || '') === (user.authVersion || '') ? user : null;
}
async function createSession(userId, expectedHash) {
  const token = random();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await db.runTransaction(async transaction => {
    const result = await transaction.collection('cp_users').doc(userId).get();
    const user = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!user || user.passwordHash !== expectedHash) throw securityError('密码已更新，请重新登录。', 401);
    await transaction.collection('cp_sessions').add({ userId, authVersion: user.authVersion || '', tokenHash: sha256(token), expiresAt, createdAt: now() });
  });
  return token;
}
const EMAIL_CODES = 'cp_email_codes';
const emailPattern = /^[.0-9a-z_-]{1,40}@[.0-9a-z_-]{1,40}\.[a-z]{1,10}$/i;
const emailError = (message, status = 400) => Object.assign(new Error(message), { status, emailVerification: true });
function emailProvider(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = https.request({
      hostname: 'cloud-paw-vip-cn-d0eub7r110788a3.api.tcloudbasegateway.com',
      path: `/auth/v1/verification${path}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('error', () => reject(emailError('邮箱验证服务连接中断，请稍后重试。', 502)));
      response.on('end', () => {
        let result;
        try { result = JSON.parse(data); }
        catch (_) { reject(emailError('邮箱验证服务返回异常，请稍后重试。', 502)); return; }
        if (response.statusCode >= 200 && response.statusCode < 300) { resolve(result); return; }
        const reason = String(result.error || result.code || '').toLowerCase();
        if (/captcha/.test(reason)) reject(emailError('邮箱服务需要额外安全验证，请稍后重试或联系网站管理员。', 503));
        else if (response.statusCode === 429 || /rate|frequent|limit/.test(reason)) reject(emailError('验证码请求过于频繁，请稍后重试。', 429));
        else if (path && /invalid|expired|verification/.test(reason)) reject(emailError('邮箱验证码错误或已过期。'));
        else reject(emailError('邮箱验证服务暂时不可用，请稍后重试。', 502));
      });
    });
    request.setTimeout(8000, () => request.destroy(new Error('timeout')));
    request.on('error', () => reject(emailError('邮箱验证服务连接超时，请稍后重试。', 502)));
    request.end(payload);
  });
}
async function startEmailVerification(email, purpose = 'signup') {
  await ensureCollection(EMAIL_CODES);
  const id = sha256(email);
  const challengeId = random();
  await db.runTransaction(async (transaction) => {
    const result = await transaction.collection(EMAIL_CODES).doc(id).get();
    const previous = Array.isArray(result.data) ? result.data[0] : result.data;
    if (previous && Date.now() - new Date(previous.sentAt).getTime() < 60000) throw emailError('请等待 60 秒后再发送验证码。', 429);
    const record = { email, purpose, challengeId, verificationId: '', attempts: 0, usedAt: null, sentAt: now(), expiresAt: now() };
    if (previous) await transaction.collection(EMAIL_CODES).doc(id).update(record);
    else await transaction.collection(EMAIL_CODES).add({ _id: id, ...record });
  });
  const result = await emailProvider('', { email, target: 'ANY' });
  if (!result.verification_id || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw emailError('邮箱验证服务返回异常，请稍后重试。', 502);
  const expiresIn = Math.min(600, result.expires_in);
  await db.collection(EMAIL_CODES).doc(id).update({ verificationId: result.verification_id, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() });
  return { ok: true, challengeId, expiresIn, retryAfter: 60 };
}
async function verifyEmailCode(email, code, challengeId, purpose = 'signup') {
  if (!/^\d{6}$/.test(code) || !/^[a-f0-9]{64}$/.test(challengeId)) throw emailError('请先获取邮箱验证码，并输入收到的 6 位验证码。');
  const record = await db.runTransaction(async (transaction) => {
    const result = await transaction.collection(EMAIL_CODES).doc(sha256(email)).get();
    const current = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!current || (current.purpose || 'signup') !== purpose || current.challengeId !== challengeId || !current.verificationId || current.usedAt || !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.now()) throw emailError('邮箱验证码错误或已过期。');
    if (current.attempts >= 5) throw emailError('验证码尝试次数过多，请重新获取。', 429);
    await transaction.collection(EMAIL_CODES).doc(current._id).update({ attempts: db.command.inc(1) });
    return { ...current };
  });
  const result = await emailProvider('/verify', { verification_id: record.verificationId, verification_code: code });
  if (!result.verification_token) throw emailError('邮箱验证服务返回异常，请稍后重试。', 502);
  return record;
}

exports.main = async (event) => {
  event = { ...event, headers: Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value])) };
  const method = String(event.httpMethod || 'GET').toUpperCase();
  const parsedUrl = new URL(String(event.path || '/'), 'https://petforge.invalid');
  const path = parsedUrl.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
  const query = event.queryStringParameters || Object.fromEntries(parsedUrl.searchParams);
  if (method === 'OPTIONS') return { statusCode: event.headers.origin && !isAllowedOrigin(event.headers.origin) ? 403 : 204, headers: headers(event.headers?.origin || ''), body: '' };
  const origin = event.headers?.origin || '';
  if (origin && !isAllowedOrigin(origin)) return reply(event, { error: '来源不被允许。' }, 403);
  try {
    if (path === '/health') return reply(event, { ok: true, region: 'cn', release: 'workshop-20261107' });
    if (method === 'POST' && ['/orders', '/admin/confirm-order'].includes(path)) return reply(event, { error: '站内支付已关闭，请登录后兑换会员码。' }, 410);
    if (!['GET','POST','PUT','DELETE'].includes(method)) return reply(event, { error: '请求方法不受支持。' }, 405);
    const body = readBody(event);
    if (method !== 'GET') await limitRequests('write-ip', clientAddress(event), 1500, 60000);
    if (method === 'GET' && path === '/workshop') {
      await ensureCollection(WORKSHOP);
      const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
      const limit = Math.min(24, Math.max(1, Math.floor(Number(query.limit) || 12)));
      const order = query.sort === 'popular' ? 'downloads' : 'createdAt';
      const base = {isPublic:true};
      if (['animal','anime'].includes(query.category)) base.category = query.category;
      else if (query.category === 'community') base.curated = db.command.neq(true);
      const term = String(query.q || '').trim().slice(0,80);
      const expression = term ? db.RegExp({regexp:term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),options:'i'}) : null;
      const conditions = expression ? db.command.and([base,db.command.or([{title:expression},{description:expression},{author:expression}])]) : base;
      const posts = await db.collection(WORKSHOP).where(conditions).field({ image: false, config: false }).orderBy(order, 'desc').skip(offset).limit(limit).get();
      return reply(event, { posts: posts.data.map((post) => publicWorkshop(post)), total: await countWhere(WORKSHOP, conditions), offset, limit });
    }
    const workshopMatch = path.match(/^\/workshop\/([a-zA-Z0-9_-]{1,80})$/);
    if (method === 'GET' && workshopMatch) {
      await ensureCollection(WORKSHOP);
      const post = await getOne(WORKSHOP, { _id: workshopMatch[1], isPublic: true });
      return post ? reply(event, { post: publicWorkshop(post, true) }) : reply(event, { error: '这个作品不存在或已取消分享。' }, 404);
    }
    if (method === 'POST' && path === '/auth/send-code') return reply(event, { error: '手机号注册暂未开放，请使用邮箱注册；已有手机号账号可使用密码登录。' }, 503);
    if (method === 'POST' && path === '/auth/send-reset-code') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!emailPattern.test(email)) return reply(event, { error: '邮箱格式不正确。' }, 400);
      await limitRequests('email-ip', clientAddress(event), 30, 3600000);
      await limitRequests('email-global', 'all', 200, 3600000);
      await limitRequests('email-address', email, 5, 3600000);
      return reply(event, await startEmailVerification(email, 'reset'));
    }
    if (method === 'POST' && path === '/auth/reset-password') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!emailPattern.test(email)) return reply(event, { error: '请填写有效邮箱。' }, 400);
      if (password.length < 8 || password !== body.confirmPassword) return reply(event, { error: '密码至少 8 位，且两次输入必须一致。' }, 400);
      await limitRequests('reset-ip', clientAddress(event), 30, 3600000);
      const verification = await verifyEmailCode(email, String(body.emailCode || '').trim(), String(body.challengeId || ''), 'reset');
      const salt = random(), hash = await passwordHash(password, salt);
      await db.runTransaction(async transaction => {
        const result = await transaction.collection(EMAIL_CODES).doc(verification._id).get();
        const current = Array.isArray(result.data) ? result.data[0] : result.data;
        if (!current || current.purpose !== 'reset' || current.challengeId !== verification.challengeId || current.usedAt || !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.now()) throw emailError('邮箱验证码错误或已过期。');
        const users = await transaction.collection('cp_users').where({ email }).limit(1).get();
        if (!users.data?.[0]) throw emailError('无法重置，请确认使用注册邮箱。');
        await transaction.collection('cp_users').doc(users.data[0]._id).update({ passwordHash: hash, passwordSalt: salt, passwordIterations: PASSWORD_ITERATIONS, authVersion: random(), passwordChangedAt: now(), emailVerifiedAt: now() });
        await transaction.collection(EMAIL_CODES).doc(current._id).update({ usedAt: now() });
      });
      return reply(event, { ok: true });
    }
    if (method === 'POST' && path === '/auth/send-email-code') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!emailPattern.test(email)) return reply(event, { error: '邮箱格式不正确。' }, 400);
      if (await getOne('cp_users', { email })) return reply(event, { error: '这个邮箱已经注册，请直接登录。' }, 409);
      await limitRequests('email-ip', clientAddress(event), 30, 3600000);
      await limitRequests('email-global', 'all', 200, 3600000);
      await limitRequests('email-address', email, 5, 3600000);
      return reply(event, await startEmailVerification(email));
    }
    if (method === 'POST' && path === '/auth/signup') {
      if (body.identity && body.identity !== 'email') return reply(event, { error: '手机号注册暂未开放，请使用邮箱注册；已有手机号账号可使用密码登录。' }, 503);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!emailPattern.test(email)) return reply(event, { error: '请填写有效邮箱。' }, 400);
      if (password.length < 8 || password !== String(body.confirmPassword || '')) return reply(event, { error: '密码至少 8 位，且两次输入必须一致。' }, 400);
      if (await getOne('cp_users', { email })) return reply(event, { error: '这个邮箱已经注册，请直接登录。' }, 409);
      await limitRequests('signup-ip', clientAddress(event), 30, 3600000);
      const verification = await verifyEmailCode(email, String(body.emailCode || '').trim(), String(body.challengeId || ''));
      const salt = random();
      const user = await db.runTransaction(async (transaction) => {
        const result = await transaction.collection(EMAIL_CODES).doc(verification._id).get();
        const current = Array.isArray(result.data) ? result.data[0] : result.data;
        if (!current || current.challengeId !== verification.challengeId || current.usedAt || !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.now()) throw emailError('邮箱验证码错误或已过期。');
        const existing = await transaction.collection('cp_users').where({ email }).limit(1).get();
        if (existing.data?.length) throw emailError('这个邮箱已经注册，请直接登录。', 409);
        const record = { email, phone: null, emailVerifiedAt: now(), phoneVerifiedAt: null, passwordHash: await passwordHash(password, salt), passwordSalt: salt, passwordIterations: PASSWORD_ITERATIONS, credits: 0, createdAt: now() };
        const added = await transaction.collection('cp_users').add(record);
        await transaction.collection(EMAIL_CODES).doc(verification._id).update({ usedAt: now() });
        return { _id: added.id || added._id, ...record };
      });
      return reply(event, { token: await createSession(user._id, user.passwordHash), user: publicUser(user) }, 201);
    }
    if (method === 'POST' && path === '/auth/login') {
      const identity = String(body.identity || 'email');
      const email = String(body.email || '').trim().toLowerCase();
      const phone = String(body.phone || '').trim();
      if (!['email','phone'].includes(identity) || (identity === 'email' ? !emailPattern.test(email) : !/^1\d{10}$/.test(phone)) || typeof body.password !== 'string' || !body.password.length) return reply(event, { error: '账号或密码不正确。' }, 401);
      await limitRequests('login-ip', clientAddress(event), 120, 15 * 60000);
      await limitRequests('login-account', identity === 'phone' ? phone : email, 8, 15 * 60000);
      const user = await getOne('cp_users', identity === 'phone' ? { phone } : { email });
      const iterations = user?.passwordIterations === PASSWORD_ITERATIONS ? PASSWORD_ITERATIONS : 100000;
      const actual = await passwordHash(body.password, user?.passwordSalt || 'petforge-unknown-account', iterations);
      const expected = /^[a-f0-9]{64}$/.test(user?.passwordHash || '') ? user.passwordHash : '0'.repeat(64);
      if (!user || !crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) return reply(event, { error: '账号或密码不正确。' }, 401);
      if (iterations < PASSWORD_ITERATIONS) {
        const salt = random();
        const hash = await passwordHash(body.password, salt);
        await db.runTransaction(async transaction => {
          const result = await transaction.collection('cp_users').doc(user._id).get();
          const current = Array.isArray(result.data) ? result.data[0] : result.data;
          if (!current || current.passwordHash !== user.passwordHash) throw securityError('密码已更新，请重新登录。', 401);
          await transaction.collection('cp_users').doc(user._id).update({ passwordHash: hash, passwordSalt: salt, passwordIterations: PASSWORD_ITERATIONS });
        });
        user.passwordHash = hash;
      }
      return reply(event, { token: await createSession(user._id, user.passwordHash), user: publicUser(user) });
    }
    if (method === 'POST' && path === '/analytics/pageview') {
      const page = String(body.page || '');
      if (!['home', 'creator', 'workshop', 'support'].includes(page)) return reply(event, { error: '页面参数无效。' }, 400);
      await ensureCollection(ADMIN_EVENTS);
      await limitRequests('analytics-ip', clientAddress(event), 60, 60000);
      await db.collection(ADMIN_EVENTS).add({ type: 'page_view', page, day: shanghaiDay(), createdAt: now() });
      return reply(event, { ok: true }, 202);
    }
    if (method === 'POST' && path === '/auth/logout') {
      const token = bearerToken(event);
      if (token) { const old = await findSession(token); if (old) await db.collection('cp_sessions').doc(old._id).remove(); }
      return reply(event, { ok: true });
    }
    const user = await sessionUser(event);
    if (!user) return reply(event, { error: '请先登录。' }, 401);
    if (method !== 'GET') {
      const limits = path === '/workshop/upload' ? [120, 60000] : path === '/workshop' ? [10, 3600000] : path === '/feedback' ? [5, 3600000] : path === '/redeem' ? [10, 15 * 60000] : [60, 60000];
      await limitRequests(`user:${path.startsWith('/admin/') ? 'admin' : path}`, user._id, ...limits);
    }
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
    if (method === 'DELETE' && workshopMatch) {
      const post = await getOne(WORKSHOP, { _id: workshopMatch[1] });
      if (!post) return reply(event, { error: '作品不存在。' }, 404);
      if (post.userId !== user._id && !isAdmin(user)) return reply(event, { error: '只能删除自己的作品。' }, 403);
      await db.collection(WORKSHOP).doc(post._id).remove();
      return reply(event, { ok: true });
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
      } catch (error) { if (error.status === 400 || error.emailVerification) return reply(event, { error: error.message }, error.status); throw error; }
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
    if (error.status === 400 || error.emailVerification || error.safe) return reply(event, { error: error.message }, error.status);
    console.error('API request failed', { path, code: String(error.code || 'INTERNAL').slice(0, 80) });
    return reply(event, { error: '会员服务暂时繁忙，请稍后再试。' }, 500);
  }
};
