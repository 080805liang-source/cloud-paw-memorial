const API_URL = window.CLOUD_PAW_API_URL;
let cloudPawSession = localStorage.getItem('cloud-paw-session') || '';
let cloudPawUser = null;
async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(cloudPawSession ? { authorization: `Bearer ${cloudPawSession}` } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '服务暂时无法连接，请稍后再试。');
  return body;
}
const client = {
  auth: {
    getUser: async () => {
      if (!cloudPawSession) return { data: { user: null } };
      try { const data = await apiRequest('/me'); cloudPawUser = { id: data.user.id, email: data.user.email, vip_expires_at: data.user.vipExpiresAt }; return { data: { user: cloudPawUser } }; }
      catch (_) { localStorage.removeItem('cloud-paw-session'); cloudPawSession = ''; cloudPawUser = null; return { data: { user: null } }; }
    },
    signInWithPassword: async ({ email, password }) => {
      try { const data = await apiRequest('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); cloudPawSession = data.token; localStorage.setItem('cloud-paw-session', cloudPawSession); cloudPawUser = { id: data.user.id, email: data.user.email, vip_expires_at: data.user.vipExpiresAt }; return { data: { user: cloudPawUser }, error: null }; } catch (error) { return { data: null, error }; }
    },
    signUp: async ({ email, password }) => {
      try { const data = await apiRequest('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) }); cloudPawSession = data.token; localStorage.setItem('cloud-paw-session', cloudPawSession); cloudPawUser = { id: data.user.id, email: data.user.email, vip_expires_at: data.user.vipExpiresAt }; return { data: { user: cloudPawUser }, error: null }; } catch (error) { return { data: null, error }; }
    },
    signOut: async () => { try { await apiRequest('/auth/logout', { method: 'POST' }); } catch (_) {} cloudPawSession = ''; cloudPawUser = null; localStorage.removeItem('cloud-paw-session'); }
  },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: cloudPawUser ? { vip_expires_at: cloudPawUser.vip_expires_at } : null }) }) }) }),
  rpc: async (_name, { voucher_code }) => {
    try { const data = await apiRequest('/redeem', { method: 'POST', body: JSON.stringify({ code: voucher_code }) }); if (cloudPawUser) cloudPawUser.vip_expires_at = data.vipExpiresAt; return { data: data.vipExpiresAt, error: null }; } catch (error) { return { data: null, error }; }
  }
};
const ritualDialog = document.querySelector('#ritual-dialog');
const memberDialog = document.querySelector('#member-dialog');
const authPanel = document.querySelector('#member-auth');
const vipPanel = document.querySelector('#member-vip');
let mode = 'login';

function openMember() { memberDialog.showModal(); refreshMember(); }
function setGate() { document.body.classList.remove('site-locked'); document.querySelector('.close-member').hidden = false; }
function formatDate(value) { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long' }).format(new Date(value)); }
async function refreshMember() {
  const { data: { user } } = await client.auth.getUser();
  authPanel.hidden = Boolean(user); vipPanel.hidden = !user;
  if (!user) { setGate(); return; }
  const { data } = await client.from('profiles').select('vip_expires_at').eq('id', user.id).maybeSingle();
  const active = data?.vip_expires_at && new Date(data.vip_expires_at) > new Date();
  setGate();
  document.querySelector('#member-title').textContent = active ? '你的云爪 VIP 正在生效' : '开通云爪 VIP';
  document.querySelector('#member-status').textContent = active ? `VIP 有效至 ${formatDate(data.vip_expires_at)}。现在可以开始为 TA 建立纪念馆。` : '输入你购买后获得的兑换码，即可开通一个月 VIP。';
}
async function requireVip() {
  const { data: { user } } = await client.auth.getUser();
  if (!user) return openMember();
  const { data } = await client.from('profiles').select('vip_expires_at').eq('id', user.id).maybeSingle();
  if (!data?.vip_expires_at || new Date(data.vip_expires_at) <= new Date()) return openMember();
  ritualDialog.showModal();
}
document.querySelector('#member-button').addEventListener('click', openMember);
document.querySelectorAll('.open-ritual').forEach((button) => button.addEventListener('click', requireVip));
function closeRitualDialog() {
  if (ritualDialog.open) ritualDialog.close();
}
document.addEventListener('click', (event) => {
  if (event.target.closest('.close-dialog')) {
    event.preventDefault();
    closeRitualDialog();
  }
}, true);
ritualDialog.addEventListener('pointerup', (event) => {
  const bounds = ritualDialog.getBoundingClientRect();
  const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (outside) closeRitualDialog();
});
document.querySelector('.close-member').addEventListener('click', () => memberDialog.close());
memberDialog.addEventListener('click', (event) => { if (event.target === memberDialog && !document.body.classList.contains('site-locked')) memberDialog.close(); });
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => { mode = button.dataset.mode; document.querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === button)); document.querySelector('#auth-form .button').innerHTML = `${mode === 'login' ? '登录' : '注册'} <span>→</span>`; }));
document.querySelector('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const email = document.querySelector('#auth-email').value.trim(); const password = document.querySelector('#auth-password').value; const note = document.querySelector('#auth-note'); note.textContent = '正在处理…';
  const response = mode === 'login' ? await client.auth.signInWithPassword({ email, password }) : await client.auth.signUp({ email, password });
  note.textContent = response.error ? response.error.message : (mode === 'signup' ? '注册成功，请输入你的 VIP 卡密开通会员。' : '登录成功。'); if (!response.error) refreshMember();
});
document.querySelector('#redeem-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const note = document.querySelector('#redeem-note'); note.textContent = '正在兑换…'; const { data, error } = await client.rpc('redeem_code', { voucher_code: document.querySelector('#redeem-code').value }); note.textContent = error ? error.message : `兑换成功，VIP 有效至 ${formatDate(data)}。`; if (!error) refreshMember();
});
document.querySelector('#signout-button').addEventListener('click', async () => { await client.auth.signOut(); refreshMember(); });
document.querySelector('#pet-photo').addEventListener('change', (event) => {
  const file = event.target.files[0];
  document.querySelector('#photo-label').textContent = file ? `已选择：${file.name}` : '点击选择照片';
});
function pickPixelPet(animal) {
  if (/虎/.test(animal)) return 'tiger';
  if (/狮/.test(animal)) return 'lion';
  if (/狐狸|狐/.test(animal)) return 'fox';
  if (/熊猫/.test(animal)) return 'panda';
  if (/熊/.test(animal)) return 'bear';
  if (/鸟|鹦鹉|雀/.test(animal)) return 'bird';
  if (/猫/.test(animal)) return 'cat';
  if (/狗|犬/.test(animal)) return 'dog';
  if (/兔/.test(animal)) return 'rabbit';
  if (/仓鼠|鼠/.test(animal)) return 'hamster';
  if (/鱼/.test(animal)) return 'fish';
  if (/龟/.test(animal)) return 'turtle';
  if (/蜥蜴|蛇/.test(animal)) return 'lizard';
  if (/马/.test(animal)) return 'horse';
  if (/羊|羊驼/.test(animal)) return 'sheep';
  if (/猪/.test(animal)) return 'pig';
  if (/鹿/.test(animal)) return 'deer';
  return 'custom';
}
function drawPixelPet(animal, personality) {
  const canvas = document.querySelector('#ceremony-pixel-art');
  const ctx = canvas.getContext('2d');
  const type = pickPixelPet(animal);
  const lively = /活泼|开朗|调皮/.test(personality);
  const fierce = /凶猛|威严|霸气|勇敢/.test(personality);
  const gentle = /温柔|安静|乖巧|害羞/.test(personality);
  const colorSeeds = [['#f7bb77', '#9a5d75', '#fff1d2'], ['#b7a3d3', '#6a4b84', '#f7e9d5'], ['#9ec9c7', '#3f7180', '#eff8df'], ['#e8a7b6', '#8b4d65', '#fff2df']];
  const seed = [...animal].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const palette = colorSeeds[seed % colorSeeds.length];
  const px = (x, y, color = palette[0]) => { ctx.fillStyle = color; ctx.fillRect(x * 10, y * 10, 10, 10); };
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f9f0e3'; ctx.fillRect(0, 0, 160, 160);
  ctx.fillStyle = '#e7d7f3'; ctx.fillRect(10, 10, 140, 140);
  if (type === 'tiger') {
    const orange = '#ef9b3d'; const dark = '#4c3041'; const cream = '#fff0cf'; const gold = '#f8c75f';
    [[5,3],[9,3],[4,4],[5,4],[6,4],[7,4],[8,4],[9,4],[10,4],[4,5],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],[4,6],[5,6],[6,6],[7,6],[8,6],[9,6],[10,6],[4,7],[5,7],[6,7],[7,7],[8,7],[9,7],[10,7],[5,8],[6,8],[7,8],[8,8],[9,8],[5,9],[6,9],[7,9],[8,9],[9,9],[6,10],[7,10],[8,10]].forEach(([x, y]) => px(x, y, orange));
    [[5,3],[9,3],[7,4],[5,5],[9,5],[4,6],[10,6],[6,7],[8,7],[7,9]].forEach(([x, y]) => px(x, y, dark));
    [[5,8],[6,8],[8,8],[9,8],[6,9],[7,9],[8,9]].forEach(([x, y]) => px(x, y, cream));
    px(6,6,fierce ? '#ffe170' : dark); px(8,6,fierce ? '#ffe170' : dark); px(7,8,dark); px(7,10,gold);
    if (lively) { px(12,3,'#f6d56e'); px(13,2,'#f6d56e'); }
    ctx.fillStyle = '#5f5471'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(animal.slice(0, 4), 80, 148);
    return;
  }
  if (type === 'custom') {
    const body = palette[0]; const shade = palette[1];
    [[5,3],[9,3],[4,4],[5,4],[6,4],[7,4],[8,4],[9,4],[10,4],[4,5],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],[4,6],[5,6],[6,6],[7,6],[8,6],[9,6],[10,6],[5,7],[6,7],[7,7],[8,7],[9,7],[5,8],[6,8],[7,8],[8,8],[9,8]].forEach(([x, y]) => px(x, y, body));
    px(6,6,shade); px(8,6,shade); px(7,8,shade);
    ctx.fillStyle = '#5f5471'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(animal.slice(0, 4), 80, 148);
    if (lively) { px(12,3,'#f6d56e'); px(13,2,'#f6d56e'); }
    if (fierce) { px(5,5,shade); px(9,5,shade); }
    return;
  }
  const shapes = {
    bird: [[7,3],[6,4],[7,4],[8,4],[5,5],[6,5],[7,5],[8,5],[9,5],[6,6],[7,6],[8,6],[7,7],[8,7],[9,6,'#ef9c6a'],[10,5,'#ef9c6a'],[5,7],[4,8]],
    cat: [[5,3],[9,3],[5,4],[6,4],[7,4],[8,4],[9,4],[5,5],[6,5],[7,5],[8,5],[9,5],[5,6],[6,6],[7,6],[8,6],[9,6],[6,7],[7,7],[8,7],[5,8],[6,8],[7,8],[8,8],[9,8]],
    dog: [[5,4],[9,4],[4,5],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],[4,6],[5,6],[6,6],[7,6],[8,6],[9,6],[10,6],[5,7],[6,7],[7,7],[8,7],[9,7],[6,8],[7,8],[8,8]],
    fox: [[5,2],[9,2],[5,3],[9,3],[4,4],[5,4],[6,4],[7,4],[8,4],[9,4],[10,4],[4,5],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],[5,6],[6,6],[7,6],[8,6],[9,6],[5,7],[6,7],[7,7],[8,7],[9,7],[6,8],[7,8],[8,8]],
    lion: [[5,2],[6,2],[7,2],[8,2],[9,2],[4,3],[5,3],[6,3],[7,3],[8,3],[9,3],[10,3],[3,4],[4,4],[5,4],[6,4],[7,4],[8,4],[9,4],[10,4],[11,4],[3,5],[4,5],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],[11,5],[4,6],[5,6],[6,6],[7,6],[8,6],[9,6],[10,6],[5,7],[6,7],[7,7],[8,7],[9,7]],
    bear: [[5,3],[9,3],[4,4],[5,4],[6,4],[7,4],[8,4],[9,4],[10,4],[4,5],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],[4,6],[5,6],[6,6],[7,6],[8,6],[9,6],[10,6],[5,7],[6,7],[7,7],[8,7],[9,7],[5,8],[6,8],[7,8],[8,8],[9,8]],
    panda: [[5,3,'#f4f1e9'],[9,3,'#f4f1e9'],[4,4,'#f4f1e9'],[5,4,'#f4f1e9'],[6,4,'#f4f1e9'],[7,4,'#f4f1e9'],[8,4,'#f4f1e9'],[9,4,'#f4f1e9'],[10,4,'#f4f1e9'],[4,5,'#f4f1e9'],[5,5,'#4c3041'],[6,5,'#f4f1e9'],[7,5,'#f4f1e9'],[8,5,'#f4f1e9'],[9,5,'#4c3041'],[10,5,'#f4f1e9'],[4,6,'#f4f1e9'],[5,6,'#f4f1e9'],[6,6,'#f4f1e9'],[7,6,'#4c3041'],[8,6,'#f4f1e9'],[9,6,'#f4f1e9'],[10,6,'#f4f1e9'],[5,7,'#f4f1e9'],[6,7,'#f4f1e9'],[7,7,'#f4f1e9'],[8,7,'#f4f1e9'],[9,7,'#f4f1e9']],
    rabbit: [[5,1],[8,1],[5,2],[8,2],[5,3],[8,3],[5,4],[6,4],[7,4],[8,4],[5,5],[6,5],[7,5],[8,5],[5,6],[6,6],[7,6],[8,6],[6,7],[7,7],[5,8],[6,8],[7,8],[8,8]],
    hamster: [[5,4],[6,4],[7,4],[8,4],[9,4],[4,5],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],[4,6],[5,6],[6,6],[7,6],[8,6],[9,6],[10,6],[5,7],[6,7],[7,7],[8,7],[9,7],[5,8],[6,8],[7,8],[8,8],[9,8]],
    fish: [[5,5],[6,4],[7,4],[8,4],[9,5],[6,5],[7,5],[8,5],[9,6],[6,6],[7,6],[8,6],[5,6],[4,5],[3,4],[3,6],[4,7]],
    turtle: [[6,4],[7,4],[8,4],[5,5],[6,5],[7,5],[8,5],[9,5],[5,6],[6,6],[7,6],[8,6],[9,6],[6,7],[7,7],[8,7],[4,6],[10,6],[5,8],[9,8]],
    lizard: [[5,5],[6,5],[7,5],[8,5],[9,5],[4,6],[5,6],[6,6],[7,6],[8,6],[9,6],[10,6],[11,6],[5,7],[6,7],[7,7],[8,7],[9,7],[3,7],[2,8],[10,7],[11,8]],
    horse: [[6,2],[7,2],[8,2],[5,3],[6,3],[7,3],[8,3],[9,3],[5,4],[6,4],[7,4],[8,4],[9,4],[5,5],[6,5],[7,5],[8,5],[9,5],[6,6],[7,6],[8,6],[6,7],[7,7],[8,7],[6,8],[7,8],[8,8]],
    sheep: [[5,3],[7,2],[9,3],[4,4],[5,4],[6,4],[7,4],[8,4],[9,4],[10,4],[4,5],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],[5,6],[6,6],[7,6],[8,6],[9,6],[5,7],[6,7],[7,7],[8,7],[9,7]],
    pig: [[5,3],[9,3],[4,4],[5,4],[6,4],[7,4],[8,4],[9,4],[10,4],[4,5],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],[4,6],[5,6],[6,6],[7,6],[8,6],[9,6],[10,6],[5,7],[6,7],[7,7],[8,7],[9,7]],
    deer: [[5,2],[9,2],[4,3],[5,3],[9,3],[10,3],[5,4],[6,4],[7,4],[8,4],[9,4],[5,5],[6,5],[7,5],[8,5],[9,5],[5,6],[6,6],[7,6],[8,6],[9,6],[6,7],[7,7],[8,7]],
    paw: [[5,4],[8,4],[4,5],[5,5],[8,5],[9,5],[6,6],[7,6],[5,7],[6,7],[7,7],[8,7],[5,8],[6,8],[7,8],[8,8]]
  };
  shapes[type].forEach(([x, y, color]) => px(x, y, color));
  if (fierce) { px(5, 5, palette[1]); px(6, 5, palette[1]); px(8, 5, palette[1]); px(9, 5, palette[1]); }
  else if (gentle) { px(6, 5, '#ffffff'); px(8, 5, '#ffffff'); px(6, 6, palette[1]); px(8, 6, palette[1]); }
  else { px(6, 5, palette[1]); px(8, 5, palette[1]); }
  if (lively) { px(12, 3, '#f6d56e'); px(13, 2, '#f6d56e'); px(12, 4, '#f6d56e'); }
  ctx.fillStyle = '#5f5471'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(animal.slice(0, 4), 80, 148);
}
function createComfortLetter({ name, animal, personality, place, impression }) {
  const mood = /凶猛|威严|霸气/.test(personality) ? '把凛然的勇气，留在每一个你需要力量的时刻' : /活泼|开朗|调皮/.test(personality) ? '把每一次雀跃，都悄悄留在你的日子里' : /勇敢|坚强/.test(personality) ? '把一小份勇气，放进你每一个想念的夜晚' : '把温柔的陪伴，藏进每一束想起 TA 的光里';
  const habit = /虎/.test(animal) ? '我会踏着林间的风，替你守护那份不肯低头的勇敢。' : /鸟|鹦鹉|雀/.test(animal) ? '我会在清晨的风里，替你唱一小段歌。' : /猫/.test(animal) ? '我会在你安静的时候，像从前一样轻轻靠近你。' : /狗|犬/.test(animal) ? '我会摇着尾巴，在每一个你回家的时刻等你。' : /兔/.test(animal) ? '我会在月光下竖起耳朵，认真听你说话。' : /鱼/.test(animal) ? '我会在安静的水光里，替你守住那些快乐。' : '我会把我们一起拥有的时光，好好珍藏。';
  return {
    title: `愿 ${name} ${mood}。`,
    voice: `“${place ? `亲爱的${place}，` : '别难过呀，'}我还是那个${animal}。${habit}${impression ? `你记得的「${impression}」，我也一直记得。` : '你想起我的时候，我就在你身边。'}”`
  };
}
let activeMemory = null;
function animalAvatar(animal) {
  if (/虎/.test(animal)) return '🐯'; if (/狮/.test(animal)) return '🦁'; if (/狐/.test(animal)) return '🦊'; if (/熊猫/.test(animal)) return '🐼'; if (/熊/.test(animal)) return '🐻'; if (/鸟|鹦鹉|雀/.test(animal)) return '🦜'; if (/猫/.test(animal)) return '🐈'; if (/狗|犬/.test(animal)) return '🐕'; if (/兔/.test(animal)) return '🐇'; if (/鱼/.test(animal)) return '🐠'; if (/龟/.test(animal)) return '🐢'; if (/蛇|蜥蜴/.test(animal)) return '🦎'; if (/马/.test(animal)) return '🐎'; if (/羊/.test(animal)) return '🐑'; return '🐾';
}
function saveActiveMemory(memory) {
  activeMemory = { ...memory, starCount: Number(memory.starCount || 0), private: Boolean(memory.private) };
  localStorage.setItem('cloud-paw-current-memory', JSON.stringify(activeMemory));
  if (cloudPawSession) apiRequest('/memorial', { method: 'PUT', body: JSON.stringify({ memorial: activeMemory }) }).catch(() => {});
}
function thoughtFor(memory, variant = 0) {
  const warm = [`今天也要好好吃饭、好好睡觉。我会在你的梦里跑过来。`, `你想起我的时候，不用急着难过；那是我们仍然相连的证据。`, `我最喜欢看你笑。今天也请替我收下一点小小的快乐。`, `别担心，我把我们一起拥有的时光，都好好带在身边。`];
  const brave = [`你是我最骄傲的家人。抬起头来，我会替你守住勇气。`, `就算我去了星光里，也会在你需要力量时陪着你。`];
  const lines = /凶猛|威严|勇敢|坚强/.test(memory.personality) ? brave.concat(warm) : warm;
  return `“${memory.place ? `亲爱的${memory.place}，` : ''}${lines[variant % lines.length]}”`;
}
function companionReplies(memory, message = '') {
  const animalHabit = /虎/.test(memory.animal) ? '我在林风里替你守住勇气' : /鸟|鹦鹉|雀/.test(memory.animal) ? '我把清晨的歌声留给你' : /猫/.test(memory.animal) ? '我会在你安静时轻轻靠近' : /狗|犬/.test(memory.animal) ? '我会摇着尾巴等你回家' : /兔/.test(memory.animal) ? '我会竖起耳朵认真听你说话' : /鱼/.test(memory.animal) ? '我会在水光里守住我们的快乐' : '我会把我们的时光好好收藏';
  const personalityTone = /凶猛|威严|勇敢|坚强/.test(memory.personality) ? '勇敢一点' : /活泼|开朗|调皮/.test(memory.personality) ? '笑一笑' : '慢一点也没关系';
  const starts = ['今天的云很像棉花糖','我刚刚在星光里打了个滚','我把一颗小星星藏在你口袋里','路过熟悉的味道时，我想起你','我偷偷看见你又在想我了','今天的风很轻，适合说悄悄话','我在梦的门口等了你一会儿','月亮替我把晚安送到了','我把最喜欢的小习惯又做了一遍','星星告诉我，你今天很努力','我听见你的心里在叫我的名字','我们一起经历的那天，我一直记得'];
  const ends = ['别难过，我只是换了一种陪你的方式。','你已经做得很好了。','想我的时候，就抬头看看那颗最亮的星。','今天也要记得喝水和吃饭。','你的笑，是我最喜欢收藏的东西。','不用急着忘记我，慢慢带着爱往前走就好。','我一直为你感到骄傲。','把你的心事说给我听吧。','我会替你看住每一个温柔的夜晚。','谢谢你曾经那么认真地爱我。'];
  return starts.flatMap((start, index) => ends.map((end, endIndex) => `“${memory.place ? `亲爱的${memory.place}，` : ''}${start}。${animalHabit}。${personalityTone}，${end}${message && index === 0 && endIndex === 0 ? ` 我听见你说：${message}` : ''}”`));
}
function memoryPromptFor(memory, index = 0) {
  const prompts = ['TA 最喜欢待在家里的哪个角落？', '有没有一个只有你和 TA 才懂的小暗号？', 'TA 做过最让你忍不住笑的一件事是什么？', '如果今天能再和 TA 散一次步，你最想去哪里？', 'TA 最喜欢的声音、气味或玩具是什么？', '你第一次见到 TA 时，心里冒出的第一个念头是什么？', 'TA 曾经怎样安慰过难过的你？', 'TA 最像哪一种天气或颜色？', '如果给 TA 写一张小纸条，你最想写哪一句？', '今天想起 TA 时，心里最先浮现的画面是什么？', 'TA 教会了你什么？', '有没有一个瞬间，让你觉得 TA 就是家人？'];
  return `回忆抽卡：${prompts[index % prompts.length]}`;
}
function renderStars(count) {
  document.querySelector('#star-field').innerHTML = Array.from({ length: Math.min(count, 12) }, () => '<span>✦</span>').join('') || '<span>·</span>';
  document.querySelector('#star-count').textContent = `已有 ${count} 颗星，被你温柔地点亮。`;
}
function renderMemorialHome(memory) {
  if (!memory?.name) return;
  saveActiveMemory(memory);
  const home = document.querySelector('#my-memorial');
  home.hidden = false;
  document.querySelector('#home-name').textContent = memory.name;
  document.querySelector('#home-title').textContent = memory.name;
  document.querySelector('#home-pixel').textContent = animalAvatar(memory.animal);
  document.querySelector('#companion-avatar').textContent = animalAvatar(memory.animal);
  document.querySelector('#home-details').textContent = `${memory.animal}${memory.personality ? ` · ${memory.personality}` : ''}`;
  document.querySelector('#home-impression').textContent = memory.impression || '这里会慢慢收集 TA 留给你的每一件小事。';
  document.querySelector('#today-letter').textContent = thoughtFor(memory, memory.thoughtIndex || 0);
  document.querySelector('#memory-prompt').textContent = memoryPromptFor(memory, memory.promptIndex || 0);
  document.querySelector('#letter-history').textContent = memory.letters?.length ? `星光信箱里，已经收下 ${memory.letters.length} 封给 TA 的小信。` : '写下的话会只保存在这台设备里。';
  document.querySelector('#reply-count').textContent = `已准备 ${companionReplies(memory).length}+ 句属于 ${memory.name} 的回应。`;
  document.querySelector('#home-date').textContent = memory.memorialDate ? `纪念日：${memory.memorialDate}` : '你可以在补充回忆时，为 TA 设置纪念日。';
  home.classList.toggle('private-mode', memory.private);
  document.querySelector('#privacy-toggle').textContent = memory.private ? '仅自己可见' : '可生成分享卡';
  renderStars(memory.starCount || 0);
  const banner = document.querySelector('#anniversary-banner');
  const today = new Date().toISOString().slice(5, 10);
  if (memory.memorialDate && memory.memorialDate.slice(5) === today) { banner.hidden = false; banner.textContent = `今天是 ${memory.name} 的纪念日。为 TA 点亮一颗星，轻轻说一声：我一直记得你。`; } else { banner.hidden = true; }
}
function openMemorialHome() {
  if (!activeMemory) return;
  ritualDialog.close();
  renderMemorialHome(activeMemory);
  document.querySelector('#my-memorial').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
document.querySelector('#memory-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = document.querySelector('#pet-name').value.trim();
  const animal = document.querySelector('#pet-animal').value.trim();
  const personality = document.querySelector('#pet-personality').value.trim();
  const place = document.querySelector('#pet-place').value.trim();
  const impression = document.querySelector('#pet-trait').value.trim();
  const memorialDate = document.querySelector('#pet-date').value;
  const photo = document.querySelector('#pet-photo').files[0];
  const showCeremony = (photoUrl = '') => {
    document.querySelector('.ritual-form').hidden = true;
    document.querySelector('#ceremony').hidden = false;
    document.querySelector('#ceremony-name').textContent = name;
    const letter = createComfortLetter({ name, animal, personality, place, impression });
    document.querySelector('#ceremony-message').textContent = letter.title;
    document.querySelector('#ceremony-voice').textContent = letter.voice;
    document.querySelector('#ceremony-trait').textContent = [personality && `性格：${personality}`, place && `在你心中：${place}`].filter(Boolean).join('　·　');
    drawPixelPet(animal, personality);
    saveActiveMemory({ name, animal, personality, place, impression, memorialDate, photoUrl, starCount: activeMemory?.starCount || 0, thoughtIndex: activeMemory?.thoughtIndex || 0, promptIndex: activeMemory?.promptIndex || 0, replyIndex: activeMemory?.replyIndex || 0, letters: activeMemory?.letters || [], private: activeMemory?.private || false });
  };
  if (!photo) return showCeremony();
  const reader = new FileReader();
  reader.addEventListener('load', () => showCeremony(reader.result));
  reader.readAsDataURL(photo);
});
document.querySelector('#save-memory').addEventListener('click', () => {
  document.querySelector('#saved-note').textContent = '这封小信已收藏，也为 TA 建好了云端小屋。';
  renderMemorialHome(activeMemory);
});
document.querySelector('#open-memorial-home').addEventListener('click', openMemorialHome);
document.querySelector('#light-star').addEventListener('click', () => { if (!activeMemory) return; activeMemory.starCount += 1; saveActiveMemory(activeMemory); renderMemorialHome(activeMemory); });
document.querySelector('#thought-button').addEventListener('click', () => { if (!activeMemory) return; activeMemory.thoughtIndex = (activeMemory.thoughtIndex || 0) + 1; saveActiveMemory(activeMemory); document.querySelector('#today-letter').textContent = thoughtFor(activeMemory, activeMemory.thoughtIndex); });
document.querySelector('#save-letter').addEventListener('click', () => { if (!activeMemory) return; const input = document.querySelector('#letter-note'); const note = input.value.trim(); if (!note) { input.focus(); return; } activeMemory.letters = [...(activeMemory.letters || []), { text: note, createdAt: new Date().toISOString() }]; input.value = ''; saveActiveMemory(activeMemory); renderMemorialHome(activeMemory); });
document.querySelector('#memory-prompt-button').addEventListener('click', () => { if (!activeMemory) return; activeMemory.promptIndex = (activeMemory.promptIndex || 0) + 1; saveActiveMemory(activeMemory); document.querySelector('#memory-prompt').textContent = memoryPromptFor(activeMemory, activeMemory.promptIndex); });
document.querySelector('#companion-talk').addEventListener('click', () => { if (!activeMemory) return; const input = document.querySelector('#companion-input'); const message = input.value.trim(); const replies = companionReplies(activeMemory, message); activeMemory.replyIndex = (activeMemory.replyIndex || 0) + 1; document.querySelector('#companion-word').textContent = replies[activeMemory.replyIndex % replies.length]; input.value = ''; saveActiveMemory(activeMemory); });
document.querySelector('#privacy-toggle').addEventListener('click', () => { if (!activeMemory) return; activeMemory.private = !activeMemory.private; saveActiveMemory(activeMemory); renderMemorialHome(activeMemory); });
document.querySelector('#share-memory').addEventListener('click', async () => { if (!activeMemory) return; const text = `我在云爪纪念馆，为 ${activeMemory.name} 留下了一颗星。愿每一份陪伴，都被温柔记得。`; try { if (navigator.share) await navigator.share({ title: `${activeMemory.name} 的纪念小屋`, text, url: location.href }); else { await navigator.clipboard.writeText(text); alert('纪念文案已复制，可以发给想一起纪念 TA 的人。'); } } catch (_) {} });
document.querySelector('#edit-memory').addEventListener('click', () => { if (!activeMemory) return; ritualDialog.showModal(); document.querySelector('.ritual-form').hidden = false; document.querySelector('#ceremony').hidden = true; document.querySelector('#pet-name').value = activeMemory.name || ''; document.querySelector('#pet-animal').value = activeMemory.animal || ''; document.querySelector('#pet-personality').value = activeMemory.personality || ''; document.querySelector('#pet-place').value = activeMemory.place || ''; document.querySelector('#pet-trait').value = activeMemory.impression || ''; document.querySelector('#pet-date').value = activeMemory.memorialDate || ''; });
try { const saved = JSON.parse(localStorage.getItem('cloud-paw-current-memory')); if (saved?.name) renderMemorialHome(saved); } catch (_) {}
async function restoreCloudMemory() {
  if (!cloudPawSession) return;
  try { const data = await apiRequest('/memorial'); if (data.memorial?.name) renderMemorialHome(data.memorial); } catch (_) {}
}
refreshMember().then(restoreCloudMemory);
