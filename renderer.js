// Twitch – app UI logic
const $ = s => document.querySelector(s);
const player = $('#player'), chat = $('#chat');

let settings = {};
let me = null, follows = [], followsPartial = false;
let subs = [], subsError = null;
const subOf = login => subs.find(x => x.login === login);
let current = null;            // { login, mode: 'live' | 'vod', vod }
let info = null;               // channel info for header
let rec = { state: 'idle', channel: null, msg: '' };
let retryTimer = null, adCount = 0;
const dls = new Map();
const nf = new Intl.NumberFormat();
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

// ---------- helpers ----------
function el(tag, props = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c != null && c !== false) e.append(c);
  return e;
}
function avatar(url, name, size) {
  if (url) {
    const i = el('img', { class: 'av', src: url, alt: '' });
    if (size) i.style.width = i.style.height = size + 'px';
    return i;
  }
  return el('span', { class: 'ph', textContent: (name || '?')[0].toUpperCase() });
}
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 4500);
}
const errText = e => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
function uptime(iso) {
  if (!iso) return '';
  const m = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
function dur(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60, p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(x)}` : `${m}:${p(x)}`;
}
const fmtSize = b => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
async function set(patch) { settings = await tw.setSettings(patch); return settings; }
const safe = fn => { try { fn(); } catch {} };
const followOf = login => follows.find(f => f.login === login);

// ---------- views ----------
function show(view) {
  for (const v of ['Channel', 'Explore', 'Saved', 'Subs']) $('#view' + v).hidden = v.toLowerCase() !== view;
  $('#navExplore').classList.toggle('on', view === 'explore');
  $('#navSaved').classList.toggle('on', view === 'saved');
  $('#navSubs').classList.toggle('on', view === 'subs');
  if (view === 'subs') renderSubs();
  if (view === 'explore') loadExplore();
  if (view === 'saved') refreshSaved();
  renderSidebar();
}
$('#navExplore').onclick = () => show('explore');
$('#navSaved').onclick = () => show('saved');
$('#navSubs').onclick = () => { show('subs'); tw.refreshSubs(); };

// ---------- sidebar ----------
function chRow(c, extra, onRemove) {
  const live = c.live;
  const row = el('div', {
    role: 'button', tabIndex: 0,
    onkeydown: e => { if (e.key === 'Enter') openChannel(c.login); },
    class: 'ch' + (live ? '' : ' off') + (current && current.login === c.login && !$('#viewChannel').hidden ? ' on' : ''),
    title: c.title || c.displayName || c.login,
    onclick: () => openChannel(c.login)
  }, [
    avatar(c.avatar, c.displayName || c.login),
    el('div', { class: 'who' }, [
      el('div', { class: 'nm', textContent: (subOf(c.login) ? '★ ' : '') + (c.displayName || c.login) }),
      el('div', { class: 'sub', textContent: live ? `${live.game || 'Live'}${live.game ? ', ' : ''}${nf.format(live.viewers)} viewers` : (extra || 'Offline') })
    ]),
    onRemove
      ? el('button', { class: 'rm', title: 'Remove from Recent', 'aria-label': 'Remove ' + c.login + ' from Recent',
          textContent: '×', onclick: e => { e.stopPropagation(); onRemove(c.login); } })
      : el('span', { class: 'dot' + (live ? ' live' : '') })
  ]);
  return row;
}
async function removeRecent(login) {
  await set({ recent: (settings.recent || []).filter(l => l !== login) });
  renderSidebar();
}
async function clearRecent() {
  await set({ recent: [] });
  renderSidebar();
}
function renderSidebar() {
  $('#loginBox').hidden = !!me;
  const live = follows.filter(f => f.live).sort((a, b) => b.live.viewers - a.live.viewers);
  const off = follows.filter(f => !f.live).sort((a, b) => a.login.localeCompare(b.login));
  $('#liveCount').textContent = live.length || '';
  $('#liveList').replaceChildren(...(live.length ? live.map(c => chRow(c)) :
    [el('p', { class: 'hint', textContent: me ? 'Nobody you follow is live right now.' : 'Log in to see who is live.' })]));
  // Followed channels: everyone you follow, live ones first, then A to Z
  const q = ($('#followFilter').value || '').trim().toLowerCase();
  const all = [...live, ...off].filter(c => !q || c.login.includes(q) || (c.displayName || '').toLowerCase().includes(q));
  $('#offCount').textContent = follows.length || '';
  $('#followFilter').hidden = follows.length < 10;
  const rows = all.map(c => chRow(c));
  if (!rows.length) rows.push(el('p', { class: 'hint', textContent: !me ? 'Log in to see the channels you follow.'
    : q ? 'No followed channel matches that.' : followsPartial ? 'Could not load your full follow list. Live ones still show above.' : 'You are not following anyone yet.' }));
  else if (followsPartial && !q) rows.push(el('p', { class: 'hint', textContent: 'Only live channels could be loaded right now.' }));
  $('#offList').replaceChildren(...rows);
  $('#followWrap').hidden = settings.followedOpen === false;
  $('#offToggle').textContent = (settings.followedOpen === false ? '▸' : '▾') + ' Followed channels';
  const recent = (settings.recent || []).filter(l => !followOf(l));
  $('#recentWrap').hidden = !recent.length;
  $('#recentList').replaceChildren(...recent.map(l => chRow({ login: l, displayName: l }, 'Recently watched', removeRecent)));

  if (me) {
    $('#meAv').replaceWith(Object.assign(avatar(me.avatar, me.displayName), { id: 'meAv' }));
    $('#meName').textContent = me.displayName;
    $('#meSub').textContent = 'Twitch account connected';
  } else {
    $('#meAv').replaceWith(Object.assign(el('span', { class: 'ph', textContent: '?' }), { id: 'meAv' }));
    $('#meName').textContent = 'Not logged in';
    $('#meSub').textContent = 'Guest';
  }
}
$('#clearRecent').onclick = clearRecent;
$('#followFilter').oninput = () => renderSidebar();
$('#refreshFollows').onclick = () => { tw.refreshFollows(); toast('Reloading your follow list. This can take up to 40 seconds.'); };
$('#offToggle').onclick = async () => {
  await set({ followedOpen: settings.followedOpen === false });
  renderSidebar();
};
$('#loginBtn').onclick = () => tw.login();
let ffWaiting = false;
async function startFirefoxLogin() {
  const btns = [$('#ffBtn'), $('#ffBtn2')];
  if (ffWaiting) { tw.cancelFirefox(); return; }
  ffWaiting = true;
  btns.forEach(b => { b.textContent = 'Waiting for Firefox… (cancel)'; });
  toast('Log in to Twitch in Firefox. This app will pick it up by itself.');
  try { const login = await tw.loginFirefox(); toast('Logged in as ' + login + '.'); $('#settings').close(); }
  catch (e) { toast(errText(e)); }
  ffWaiting = false;
  btns.forEach(b => { b.textContent = 'Log in with Firefox'; });
}
$('#ffBtn').onclick = startFirefoxLogin;
$('#ffBtn2').onclick = startFirefoxLogin;
$('#loginBtn2').onclick = () => { $('#settings').close(); tw.login(); };
tw.on('ff-login-start', () => { if (!ffWaiting && !me) $('#ffBtn').click(); });
$('#tokenBtn').onclick = () => { $('#tokenInput').value = ''; $('#tokenDlg').showModal(); $('#tokenInput').focus(); };
$('#tokenCancel').onclick = () => $('#tokenDlg').close();
$('#tokenSave').onclick = async () => {
  const btn = $('#tokenSave');
  btn.disabled = true;
  try {
    const login = await tw.loginToken($('#tokenInput').value);
    $('#tokenDlg').close();
    toast('Logged in as ' + login + '.');
  } catch (e) { toast(errText(e)); }
  btn.disabled = false;
};

tw.on('follows', d => {
  me = d.me; follows = d.follows || []; followsPartial = !!d.partial;
  renderSidebar();
  if (!$('#viewExplore').hidden) renderExploreFollows();
  if (current) { const f = followOf(current.login); if (f && info) { info.live = f.live; info.title = f.title || info.title; renderHeader(); } }
});
tw.on('follows-error', m => {
  if (follows.length) return;
  $('#liveList').replaceChildren(el('p', { class: 'hint', textContent: m + ' Retrying every minute.' }));
});
tw.on('auth-changed', () => { tw.log('auth-changed: reloading chat + player'); safe(() => chat.reload()); safe(() => player.reload()); });
tw.on('open-channel', login => openChannel(login));

// ---------- channel ----------
const playerUrl = login => `https://player.twitch.tv/?channel=${encodeURIComponent(login)}&parent=twitch.tv&autoplay=true&muted=false`;
const vodUrl = id => `https://player.twitch.tv/?video=v${id}&parent=twitch.tv&autoplay=true&muted=false`;
const chatUrl = login => `https://www.twitch.tv/popout/${encodeURIComponent(login)}/chat?popout=`;

async function openChannel(login, tab = 'live') {
  login = String(login || '').trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//, '').split(/[/?#]/)[0];
  if (!/^[a-z0-9_]{2,25}$/.test(login)) { toast('That does not look like a channel name.'); return; }
  tw.log('openChannel ' + login);
  current = { login, mode: 'live' };
  info = followOf(login) ? { ...followOf(login) } : { login, displayName: login };
  showLat(null);
  chat.src = chatUrl(login);
  if (tab === 'live') player.src = playerUrl(login);
  else if (player.src) { try { player.executeJavaScript("document.querySelectorAll('video').forEach(v => v.pause())").catch(() => {}); } catch {} }
  setTab(tab);
  renderHeader();
  show('channel');
  const recent = [login, ...(settings.recent || []).filter(l => l !== login)].slice(0, 8);
  set({ lastChannel: login, recent });
  updateRecording();
  loadInfo();
  checkFollow(login);
}
async function loadInfo() {
  if (!current) return;
  const login = current.login;
  try {
    const d = await tw.channelInfo(login);
    if (!current || current.login !== login) return;
    if (!d) { toast(`Channel "${login}" was not found.`); return; }
    info = d;
    renderHeader();
  } catch (e) { console.warn(e); }
}
setInterval(() => { if (current && !$('#viewChannel').hidden) loadInfo(); }, 60000);

function renderHeader() {
  if (!info) return;
  const img = $('#chAv');
  if (info.avatar) { img.src = info.avatar; img.hidden = false; } else img.hidden = true;
  $('#chName').textContent = info.displayName || info.login;
  $('#chTitle').textContent = info.title || '';
  const st = [];
  if (info.live) {
    st.push(el('span', { class: 'liveTag', textContent: '● Live' }));
    st.push(el('span', { textContent: nf.format(info.live.viewers) + ' watching' }));
    st.push(el('span', { textContent: uptime(info.live.startedAt) }));
  } else st.push(el('span', { textContent: 'Offline' }));
  if (info.followers != null) st.push(el('span', { textContent: compact.format(info.followers) + ' followers' }));
  const game = (info.live && info.live.game) || info.game;
  if (game) st.push(el('span', { class: 'chip', textContent: game }));
  $('#chStats').replaceChildren(...st);

  renderFollowBtn();
  const sub = subOf(current.login);
  const sb = $('#subBtn');
  sb.classList.toggle('subbed', !!sub);
  sb.textContent = sub ? '★ Subscribed' + (sub.tier ? ' (Tier ' + sub.tier + ')' : '') : '★ Subscribe';
  sb.title = sub ? 'Manage or gift subs on Twitch' : 'Subscribe on Twitch (opens in Firefox)';
  const followed = !!followOf(current.login);
  const bell = $('#bellBtn');
  bell.hidden = !followed;
  const notifyOn = followed && !(settings.muted || []).includes(current.login);
  bell.classList.toggle('on', notifyOn);
  bell.textContent = notifyOn ? '🔔 Notifying' : '🔕 Notify';
  $('#pLabel').textContent = current.mode === 'vod' ? (current.vod.title || 'Past broadcast') : '# ' + (info.displayName || info.login);
  $('#vodDl').hidden = current.mode !== 'vod';
  $('#backLive').hidden = current.mode !== 'vod';
  renderSidebar();
}
let followKnown = {}; // login -> true/false from Twitch
function isFollowing(login) { return login in followKnown ? followKnown[login] : !!followOf(login); }
function renderFollowBtn() {
  if (!current) return;
  const b = $('#followBtn'), on = isFollowing(current.login);
  b.classList.toggle('on', on);
  b.textContent = on ? '♥ Following' : '♡ Follow';
  b.title = on ? 'Click to unfollow' : 'Follow this channel';
}
async function checkFollow(login) {
  if (!me) return;
  const st = await tw.followState(login);
  if (st.known && current && current.login === login) { followKnown[login] = st.following; renderFollowBtn(); }
}
$('#followBtn').onclick = async () => {
  if (!current) return;
  if (!me) { toast('Log in first to follow channels.'); return; }
  const login = current.login, want = !isFollowing(login);
  if (!want && !confirm('Unfollow ' + (info && info.displayName || login) + '?')) return;
  const b = $('#followBtn'); b.disabled = true;
  try {
    await tw.setFollow(login, want);
    followKnown[login] = want; renderFollowBtn();
    toast(want ? 'Following ' + login + '.' : 'Unfollowed ' + login + '.');
  } catch (e) {
    tw.openFirefox('https://www.twitch.tv/' + login);
    toast('Twitch did not let the app do that, so the channel opened in Firefox. Press Follow there.');
  }
  b.disabled = false;
};
$('#subBtn').onclick = () => {
  if (!current) return;
  if (!me) { toast('Log in first to subscribe.'); return; }
  const url = subOf(current.login) ? 'https://www.twitch.tv/subscriptions' : `https://www.twitch.tv/subs/${current.login}`;
  tw.openFirefox(url);
  toast('Opened in Firefox. Finish there, then press Refresh in Subscriptions.');
};
$('#bellBtn').onclick = async () => {
  if (!current) return;
  const muted = new Set(settings.muted || []);
  muted.has(current.login) ? muted.delete(current.login) : muted.add(current.login);
  await set({ muted: [...muted] });
  renderHeader();
};

// tabs: live / past broadcasts
function setTab(t) {
  $('#tabLive').setAttribute('aria-pressed', String(t === 'live'));
  $('#tabPast').setAttribute('aria-pressed', String(t === 'past'));
  $('#stage').hidden = t !== 'live';
  $('#pastPage').hidden = t !== 'past';
  if (t === 'past') loadPast();
  // load the live player only when you actually go to the Live tab
  if (t === 'live' && current && current.mode === 'live' && !String(player.src || '').includes('channel=' + encodeURIComponent(current.login))) {
    player.src = playerUrl(current.login);
  }
}
$('#tabLive').onclick = () => setTab('live');
$('#tabPast').onclick = () => setTab('past');

async function loadPast() {
  const grid = $('#pastGrid');
  grid.replaceChildren(el('p', { class: 'empty', textContent: 'Loading…' }));
  const login = current.login;
  try {
    const vids = await tw.channelVideos(login);
    if (current.login !== login) return;
    if (!vids.length) { grid.replaceChildren(el('p', { class: 'empty', textContent: 'This channel has no past broadcasts available.' })); return; }
    grid.replaceChildren(...vids.map(v => el('div', { class: 'card' }, [
      el('button', { class: 'card', style: 'padding:0', onclick: () => playVod(v) }, [
        el('div', { class: 'thumb' }, [
          v.previewThumbnailURL ? el('img', { src: v.previewThumbnailURL, alt: '' }) : null,
          el('span', { class: 'badge', textContent: dur(v.lengthSeconds || 0) })
        ]),
        el('div', { class: 'who' }, [
          el('div', { class: 't', textContent: v.title || 'Untitled broadcast' }),
          el('div', { class: 'm', textContent: `${new Date(v.createdAt).toLocaleDateString()}, ${nf.format(v.viewCount || 0)} views` })
        ])
      ]),
      el('div', { class: 'card-acts' }, [
        el('button', { class: 'btn primary', textContent: 'Watch', onclick: () => playVod(v) }),
        el('button', { class: 'btn', textContent: 'Download', onclick: () => downloadVod(v.id) })
      ])
    ])));
  } catch (e) {
    grid.replaceChildren(el('p', { class: 'empty', textContent: 'Could not load past broadcasts: ' + errText(e) }));
  }
}
function playVod(v) {
  current = { ...current, mode: 'vod', vod: v };
  player.src = vodUrl(v.id);
  showLat(null);
  setTab('live');
  renderHeader();
}
$('#backLive').onclick = () => { current = { login: current.login, mode: 'live' }; player.src = playerUrl(current.login); renderHeader(); };
$('#vodDl').onclick = () => { if (current && current.vod) downloadVod(current.vod.id); };
async function downloadVod(id) {
  try { await tw.vodDownload(`https://www.twitch.tv/videos/${id}`); toast('Downloading. Progress is in Saved streams.'); }
  catch (e) { toast(errText(e)); }
}

// ---------- video panel ----------
function applyVideoLayout() {
  $('#stage').style.setProperty('--vw', (settings.videoWidth || 58) + '%');
  $('#stage').classList.toggle('novideo', !!settings.hideVideo);
  $('#hideVideo').textContent = settings.hideVideo ? 'Show video' : 'Hide video';
}
$('#hideVideo').onclick = async () => { await set({ hideVideo: !settings.hideVideo }); applyVideoLayout(); };
$('#split').addEventListener('pointerdown', e => {
  const stage = $('#stage'), rect = stage.getBoundingClientRect();
  document.body.classList.add('dragging');
  $('#split').setPointerCapture(e.pointerId);
  const move = ev => {
    const pct = Math.min(80, Math.max(25, ((rect.right - ev.clientX) / rect.width) * 100));
    stage.style.setProperty('--vw', pct.toFixed(1) + '%');
    settings.videoWidth = +pct.toFixed(1);
  };
  const up = () => {
    document.body.classList.remove('dragging');
    $('#split').removeEventListener('pointermove', move);
    $('#split').removeEventListener('pointerup', up);
    set({ videoWidth: settings.videoWidth });
  };
  $('#split').addEventListener('pointermove', move);
  $('#split').addEventListener('pointerup', up);
});

function sendCfg() {
  try { player.send('cfg', { autoLive: !!settings.autoLive, threshold: Number(settings.threshold) || 6, catchUp: !!settings.catchUp }); } catch {}
}
player.addEventListener('dom-ready', sendCfg);
chat.addEventListener('ipc-message', e => {
  if (e.channel !== 'poll') return;
  const d = e.args[0];
  const bar = $('#voteBar');
  if (!d) { bar.hidden = true; return; }
  $('#voteKind').textContent = d.kind === 'prediction' ? 'Prediction running' : 'Poll running';
  $('#voteText').textContent = d.text || '';
  $('#voteBar').querySelector('.vb-go').textContent = d.kind === 'prediction' ? 'Predict now' : 'Vote now';
  bar.hidden = false;
});
$('#voteBar').onclick = () => { try { chat.send('cmd', 'open-poll'); chat.focus(); } catch {} };
chat.addEventListener('did-start-navigation', e => { if (e.isMainFrame) $('#voteBar').hidden = true; });
player.addEventListener('ipc-message', e => {
  if (e.channel === 'lat') showLat(e.args[0]);
  else if (e.channel === 'ad') {
    adCount += (e.args[0] && e.args[0].removed) || 0;
    $('#shield').textContent = '🛡 ' + adCount;
  }
});
function showLat(d) {
  const b = $('#lag');
  if (!d || !current || current.mode !== 'live') { b.hidden = true; return; }
  b.hidden = false;
  b.textContent = (d.lag < 1 ? 'LIVE' : '−' + d.lag.toFixed(1) + 's') + (d.rate > 1.01 ? ' ⏩' : '') + (d.paused ? ' ⏸' : '');
  b.className = 'lag ' + (d.lag < 3 ? 'good' : d.lag < 8 ? 'warn' : 'bad');
}
$('#lag').onclick = () => { try { player.send('cmd', 'golive'); } catch {} };
$('#quality').onchange = async e => { await set({ quality: e.target.value }); safe(() => player.reload()); };
$('#pip').onclick = () => player.executeJavaScript(`(() => { const v = document.querySelector('video');
  if (document.pictureInPictureElement) document.exitPictureInPicture(); else if (v) v.requestPictureInPicture(); })()`, true).catch(() => {});
$('#fs').onclick = () => player.executeJavaScript(`document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()`, true).catch(() => {});

// ---------- recording ----------
function renderRec() {
  const b = $('#recBtn'), s = $('#recState');
  b.classList.toggle('on', !!settings.autoRecord);
  s.className = 'recstate'; s.title = '';
  if (!settings.autoRecord) { s.textContent = ''; return; }
  const map = {
    recording: () => { s.textContent = '● REC ' + rec.channel; s.classList.add('live'); },
    starting: () => { s.textContent = 'starting…'; },
    offline: () => { s.textContent = 'offline, retrying'; },
    ended: () => { s.textContent = 'stream ended'; },
    error: () => { s.textContent = '⚠ failed'; s.title = rec.msg || ''; }
  };
  (map[rec.state] || (() => { s.textContent = ''; }))();
}
function updateRecording() {
  if (!settings.autoRecord || !current) return;
  const ch = current.login;
  if (ch === rec.channel && ['recording', 'starting', 'offline', 'ended'].includes(rec.state)) return;
  clearTimeout(retryTimer);
  rec = { state: 'starting', channel: ch, msg: '' };
  renderRec();
  tw.recStart(ch);
}
tw.on('rec-update', d => {
  if (d.channel !== rec.channel && d.state !== 'recording') return;
  rec = { state: d.state, channel: d.channel, msg: d.msg || '' };
  if (d.state === 'error' && d.msg) toast('Recording failed: ' + d.msg);
  if ((d.state === 'offline' || d.state === 'ended') && settings.autoRecord) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (settings.autoRecord && current && current.login === d.channel) {
        rec = { state: 'starting', channel: d.channel, msg: '' }; renderRec(); tw.recStart(d.channel);
      }
    }, 60000);
  }
  renderRec();
  if (!$('#viewSaved').hidden) refreshSaved();
});
$('#recBtn').onclick = async () => {
  await set({ autoRecord: !settings.autoRecord });
  clearTimeout(retryTimer);
  if (settings.autoRecord) { rec = { state: 'idle', channel: null, msg: '' }; updateRecording(); toast('Saving streams you watch.'); }
  else tw.recStop();
  renderRec();
};

// ---------- downloads + saved ----------
tw.on('dl-update', d => {
  dls.set(d.id, d);
  if (d.state === 'done') { toast('Saved: ' + d.title); dls.delete(d.id); }
  if (d.state === 'error') { toast('Download failed: ' + (d.msg || 'unknown error')); dls.delete(d.id); }
  if (d.state === 'cancelled') dls.delete(d.id);
  const n = [...dls.values()].filter(x => x.state === 'downloading').length;
  $('#dlCount').textContent = n ? n + ' downloading' : '';
  if (!$('#viewSaved').hidden) refreshSaved();
});
async function refreshSaved() {
  const list = await tw.savedList();
  const box = $('#savedList');
  $('#savedDir').textContent = settings.saveDir;
  const rows = [];
  for (const d of dls.values()) {
    if (d.state !== 'downloading') continue;
    const bar = el('div', { class: 'progress' }, el('i'));
    bar.firstChild.style.width = (d.pct || 0) + '%';
    rows.push(el('div', { class: 'item' }, [
      el('div', {}, [el('div', { class: 'nm', textContent: d.title }), el('div', { class: 'm', textContent: `Downloading ${(d.pct || 0).toFixed(1)}%` }), bar]),
      el('div', { class: 'acts' }, el('button', { class: 'btn', textContent: 'Cancel', onclick: () => tw.vodCancel(d.id) }))
    ]));
  }
  for (const f of list) {
    rows.push(el('div', { class: 'item' }, [
      el('div', {}, [el('div', { class: 'nm', textContent: f.name }),
        el('div', { class: 'm' }, [`${fmtSize(f.size)}, ${new Date(f.mtime).toLocaleString()}`,
          f.recording ? el('span', { class: 'reclive', textContent: '  ● recording' }) : null])]),
      el('div', { class: 'acts' }, [
        el('button', { class: 'btn primary', textContent: 'Play', onclick: () => tw.savedOpen(f.path) }),
        el('button', { class: 'btn', textContent: 'Show', onclick: () => tw.savedReveal(f.path) }),
        el('button', { class: 'btn', textContent: 'Delete', disabled: f.recording, onclick: async () => {
          if (confirm(`Move "${f.name}" to the trash?`)) { await tw.savedDelete(f.path); refreshSaved(); }
        } })
      ])
    ]));
  }
  if (!rows.length) rows.push(el('p', { class: 'empty', textContent:
    'Nothing saved yet. Turn on Save streams while watching, or download something from a channel\'s Past broadcasts.' }));
  box.replaceChildren(...rows);
}
$('#refreshSaved').onclick = refreshSaved;
$('#openDir').onclick = () => tw.openSaveDir();
setInterval(() => { if (!$('#viewSaved').hidden && rec.state === 'recording') refreshSaved(); }, 10000);

// ---------- subscriptions ----------
function fmtDate(iso) { try { return new Date(iso).toLocaleDateString(); } catch { return ''; } }
function renderSubs() {
  const grid = $('#subsGrid');
  $('#subsCount').textContent = subs.length || '';
  if (!me) { grid.replaceChildren(el('p', { class: 'empty', textContent: 'Log in to see the channels you subscribe to.' })); return; }
  if (!subs.length) {
    grid.replaceChildren(el('p', { class: 'empty', textContent: subsError
      ? 'Could not load your subscriptions from Twitch right now. Press Refresh to try again.'
      : 'You are not subscribed to any channels yet. Open a channel and press Subscribe.' }));
    return;
  }
  const sorted = [...subs].sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || a.login.localeCompare(b.login));
  grid.replaceChildren(...sorted.map(c => {
    const renew = c.renewsAt ? 'Renews ' + fmtDate(c.renewsAt) : c.endsAt ? 'Ends ' + fmtDate(c.endsAt) : '';
    return el('div', { class: 'subcard' }, [
      el('button', { class: 'top', title: 'See past streams', onclick: () => openChannel(c.login, 'past') }, [
        avatar(c.avatar, c.displayName, 48),
        el('div', { class: 'who' }, [
          el('div', { class: 't', textContent: c.displayName }),
          c.live ? el('div', { class: 'm live', textContent: `● Live: ${c.live.game || ''} ${nf.format(c.live.viewers)} watching` })
                 : el('div', { class: 'm', textContent: renew || 'Offline' })
        ]),
        c.tier ? el('span', { class: 'tierchip', textContent: 'Tier ' + c.tier }) : null
      ]),
      el('div', { class: 'card-acts' }, [
        el('button', { class: 'btn primary', textContent: 'Past streams', onclick: () => openChannel(c.login, 'past') }),
        c.live ? el('button', { class: 'btn', textContent: 'Watch live', onclick: () => openChannel(c.login, 'live') }) : null
      ])
    ]);
  }));
}
tw.on('subs', d => {
  subs = d.subs || []; subsError = d.error || null;
  $('#subsCount').textContent = subs.length || '';
  if (!$('#viewSubs').hidden) renderSubs();
  if (current && info) renderHeader(); else renderSidebar();
});
$('#refreshSubs').onclick = () => { $('#subsGrid').replaceChildren(el('p', { class: 'empty', textContent: 'Loading…' })); tw.refreshSubs(); };
$('#manageSubs').onclick = () => tw.openFirefox('https://www.twitch.tv/subscriptions');

// ---------- explore ----------
function renderExploreFollows() {
  const live = follows.filter(f => f.live).sort((a, b) => b.live.viewers - a.live.viewers);
  $('#exFollowWrap').hidden = !live.length;
  $('#exFollow').replaceChildren(...live.map(c => el('button', { class: 'followcard', onclick: () => openChannel(c.login) }, [
    avatar(c.avatar, c.displayName, 40),
    el('div', { class: 'who', style: 'min-width:0' }, [
      el('div', { class: 't', style: 'font-weight:600', textContent: c.displayName }),
      el('div', { class: 'm', style: 'font-size:12px;color:var(--muted)', textContent: `${c.live.game || 'Live'}, ${nf.format(c.live.viewers)} watching` })
    ])
  ])));
}
let exploreLoaded = 0;
async function loadExplore() {
  renderExploreFollows();
  if (Date.now() - exploreLoaded < 60000) return;
  try {
    const top = await tw.exploreTop();
    exploreLoaded = Date.now();
    $('#exTop').replaceChildren(...top.map(s => el('button', { class: 'card', onclick: () => openChannel(s.login) }, [
      el('div', { class: 'thumb' }, [
        s.thumb ? el('img', { src: s.thumb, alt: '' }) : null,
        el('span', { class: 'badge', textContent: '● ' + nf.format(s.viewers) })
      ]),
      el('div', { class: 'row' }, [
        avatar(s.avatar, s.displayName),
        el('div', { class: 'who' }, [
          el('div', { class: 't', textContent: s.title || s.displayName }),
          el('div', { class: 'm', textContent: s.displayName + (s.game ? ', ' + s.game : '') })
        ])
      ])
    ])));
  } catch (e) {
    $('#exTop').replaceChildren(el('p', { class: 'empty', textContent: 'Could not load top channels: ' + errText(e) }));
  }
}

// ---------- search ----------
let searchSeq = 0;
$('#searchForm').onsubmit = async e => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  if (!q) return;
  const seq = ++searchSeq;
  $('#searchWrap').hidden = false; $('#searchClear').hidden = false;
  $('#searchTitle').textContent = 'Results for "' + q + '"';
  $('#searchGrid').replaceChildren(el('p', { class: 'empty', textContent: 'Searching…' }));
  let list = [];
  try { list = await tw.searchChannels(q); } catch (err) { console.warn(err); }
  if (seq !== searchSeq) return;
  if (!list.length) { $('#searchGrid').replaceChildren(el('p', { class: 'empty', textContent: 'No channels found. Try the exact channel name.' })); return; }
  $('#searchGrid').replaceChildren(...list.map(c => el('button', { class: 'followcard', onclick: () => openChannel(c.login) }, [
    avatar(c.avatar, c.displayName, 44),
    el('div', { class: 'who', style: 'min-width:0' }, [
      el('div', { class: 't', style: 'font-weight:700', textContent: (subOf(c.login) ? '★ ' : '') + c.displayName }),
      el('div', { class: 'm', style: 'font-size:12px;color:' + (c.live ? 'var(--rec)' : 'var(--muted)'), textContent: c.live
        ? `● Live: ${c.live.game || ''} ${nf.format(c.live.viewers)} watching`
        : (c.followers != null ? compact.format(c.followers) + ' followers' : 'Offline') })
    ])
  ])));
};
$('#searchClear').onclick = () => { searchSeq++; $('#searchInput').value = ''; $('#searchWrap').hidden = true; $('#searchClear').hidden = true; $('#searchInput').focus(); };

// ---------- join ----------
function openJoin() { $('#joinInput').value = ''; $('#join').showModal(); $('#joinInput').focus(); }
$('#navJoin').onclick = openJoin;
document.addEventListener('keydown', e => { if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openJoin(); } });
$('#joinForm').onsubmit = () => { const v = $('#joinInput').value.trim(); if (v) openChannel(v); };

// ---------- settings ----------
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme === 'dark' ? 'dark' : 'light';
  $('#thLight').setAttribute('aria-pressed', String(settings.theme !== 'dark'));
  $('#thDark').setAttribute('aria-pressed', String(settings.theme === 'dark'));
}
async function setTheme(t) {
  await set({ theme: t }); applyTheme();
  try { chat.reload(); } catch {}
}
$('#thLight').onclick = () => setTheme('light');
$('#thDark').onclick = () => setTheme('dark');
$('#gear').onclick = () => { refreshYt(); $('#acctState').textContent = me ? 'Logged in as ' + me.displayName : 'Not logged in'; $('#settings').showModal(); };
$('#closeSettings').onclick = () => $('#settings').close();
const bindCheck = (id, key, after) => { $(id).onchange = async e => { await set({ [key]: e.target.checked }); if (after) after(); }; };
bindCheck('#notify', 'notify');
bindCheck('#background', 'background');
bindCheck('#autoLive', 'autoLive', sendCfg);
bindCheck('#catchUp', 'catchUp', sendCfg);
bindCheck('#adblock', 'adblock', () => { try { player.reload(); } catch {} });
$('#threshold').onchange = async e => {
  const v = Math.min(60, Math.max(3, Math.round(Number(e.target.value) || 6)));
  e.target.value = v; await set({ threshold: v }); sendCfg();
};
$('#recQuality').onchange = e => set({ recordQuality: e.target.value });
$('#changeDir').onclick = async () => { settings = await tw.pickFolder(); $('#saveDir').textContent = settings.saveDir; };
$('#scriptsDir').onclick = () => tw.openScriptsDir();
$('#logoutBtn').onclick = async () => { if (confirm('Log out of Twitch?')) { await tw.logout(); $('#settings').close(); safe(() => chat.reload()); } };
$('#quitBtn').onclick = () => tw.quit();
async function refreshYt() {
  const p = await tw.ytdlpStatus();
  $('#ytStatus').textContent = p ? 'Installed' : 'Needed for saving streams';
  $('#ytInstall').textContent = p ? 'Update' : 'Install yt-dlp';
}
$('#ytInstall').onclick = async () => {
  $('#ytInstall').disabled = true; $('#ytStatus').textContent = 'Downloading…';
  try { await tw.ytdlpInstall(); toast('yt-dlp installed.'); } catch (e) { toast('yt-dlp install failed: ' + errText(e)); }
  $('#ytInstall').disabled = false; refreshYt();
};

// ---------- start ----------
(async function init() {
  settings = await tw.getSettings();
  applyTheme();
  applyVideoLayout();
  $('#quality').value = settings.quality;
  $('#notify').checked = !!settings.notify;
  $('#background').checked = !!settings.background;
  $('#autoLive').checked = !!settings.autoLive;
  $('#threshold').value = settings.threshold;
  $('#catchUp').checked = !!settings.catchUp;
  $('#adblock').checked = !!settings.adblock;
  $('#recQuality').value = settings.recordQuality;
  $('#saveDir').textContent = settings.saveDir;
  renderRec();
  const d = await tw.getFollows();
  me = d.me; follows = d.follows || [];
  const sd = await tw.getSubs(); subs = sd.subs || []; subsError = sd.error;
  $('#subsCount').textContent = subs.length || '';
  renderSidebar();
  if (settings.lastChannel) openChannel(settings.lastChannel); else show('explore');
})();
