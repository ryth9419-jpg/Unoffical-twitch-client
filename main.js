// Twitch (TwitchWatch) – main process
const { app, BrowserWindow, ipcMain, session, shell, dialog, Notification, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

app.setName('Twitch');

const PARTITION = 'persist:twitch';
const GQL_CLIENT = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // Twitch's public web client id
const TWITCH_RE = /^https:\/\/([a-z0-9-]+\.)*twitch\.tv(\/|$|\?)/i;
// Twitch login pages plus the social sign-in providers Twitch uses (Google, Apple, Facebook)
const LOGIN_POPUP_RE = /^https:\/\/(id|passport|www)\.twitch\.tv\//i;
// Google/Apple/Amazon/Facebook block sign-in inside apps, so these get handed to Firefox instead
const SOCIAL_RE = /^https:\/\/(accounts\.google\.com|appleid\.apple\.com|([a-z]+\.)?amazon\.[a-z.]+|([a-z]+\.)?facebook\.com)\//i;
const VIDEO_EXT = /\.(mp4|ts|mkv|webm|flv|mov)$/i;
const ICON = path.join(__dirname, 'build', 'icon.png');

let win = null, tray = null, loginWin = null, quitting = false;
let settings = {};
let blocker = null;
let rec = null;
const downloads = new Map();
let knownToken = null;
let me = null, follows = [], liveSet = null, pollTimer = null;
const liveNotes = []; // keep references so click handlers survive GC

// ---------- never show crash dialogs for a closed terminal (EPIPE) ----------
for (const st of [process.stdout, process.stderr]) { try { st.on('error', () => {}); } catch {} }
process.on('uncaughtException', err => {
  try { dbg('uncaught: ' + (err && err.stack || err)); } catch {}
});
process.on('unhandledRejection', err => {
  try { dbg('unhandled rejection: ' + (err && err.stack || err)); } catch {}
});

// ---------- debug log (~/.config/Twitch/debug.log) ----------
function dbg(msg) {
  try {
    const f = path.join(app.getPath('userData'), 'debug.log');
    try { if (fs.statSync(f).size > 500000) fs.renameSync(f, f + '.old'); } catch {}
    fs.appendFileSync(f, new Date().toISOString().slice(11, 23) + '  ' + msg + '\n');
  } catch {}
}

// ---------- settings ----------
function defaults() {
  return {
    saveDir: path.join(app.getPath('videos'), 'Twitch'),
    theme: 'light', notify: true, background: true, muted: [], recent: [],
    adblock: true, autoLive: true, threshold: 6, catchUp: true,
    quality: 'auto', recordQuality: 'best', autoRecord: false,
    videoWidth: 58, hideVideo: false, lastChannel: null
  };
}
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const scriptsDir = () => path.join(app.getPath('userData'), 'scripts');
function loadSettings() {
  settings = defaults();
  try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch {}
}
function saveSettings() {
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); }
  catch (e) { console.error('settings save failed', e); }
}
function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }
function showWin() { if (!win) return createWindow(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function inSaveDir(p) { return path.resolve(p).startsWith(path.resolve(settings.saveDir) + path.sep); }
const ses = () => session.fromPartition(PARTITION);

// ---------- Twitch data (GQL, using your logged-in session) ----------
async function authToken() {
  try { const c = await ses().cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' }); return c[0] ? c[0].value : null; }
  catch { return null; }
}
async function gql(query, variables = {}, token) {
  const headers = { 'Client-ID': GQL_CLIENT, 'Content-Type': 'text/plain;charset=UTF-8' };
  const t = token !== undefined ? token : await authToken();
  if (t) headers.Authorization = 'OAuth ' + t;
  const r = await fetch('https://gql.twitch.tv/gql', { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  if (!r.ok) throw new Error('Twitch returned HTTP ' + r.status);
  const j = await r.json();
  if (!j.data) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || 'Twitch returned no data');
  return j.data;
}
const Q_FOLLOWS = `query($c: Cursor) { currentUser { login displayName profileImageURL(width: 70)
  follows(first: 100, after: $c) { edges { cursor node { login displayName profileImageURL(width: 70)
    broadcastSettings { title } stream { viewersCount createdAt game { displayName } } } } pageInfo { hasNextPage } } } }`;
const Q_FOLLOWS_SIMPLE = `query { currentUser { login displayName profileImageURL(width: 70)
  follows(first: 100) { edges { node { login displayName profileImageURL(width: 70)
    broadcastSettings { title } stream { viewersCount createdAt game { displayName } } } } pageInfo { hasNextPage } } } }`;
const Q_CHANNEL = `query($l: String!) { user(login: $l) { login displayName profileImageURL(width: 150)
  followers { totalCount } broadcastSettings { title game { displayName } }
  stream { viewersCount createdAt game { displayName } } } }`;
const Q_VIDEOS = `query($l: String!) { user(login: $l) { videos(first: 30, type: ARCHIVE, sort: TIME) { edges { node {
  id title lengthSeconds createdAt viewCount previewThumbnailURL(width: 320, height: 180) } } } } }`;
const Q_VIDEOS_ANY = `query($l: String!) { user(login: $l) { videos(first: 30) { edges { node {
  id title lengthSeconds createdAt viewCount previewThumbnailURL(width: 320, height: 180) } } } } }`;
const Q_TOP = `query { streams(first: 30) { edges { node { viewersCount previewImageURL(width: 440, height: 248)
  game { displayName } broadcaster { login displayName profileImageURL(width: 70) broadcastSettings { title } } } } } }`;

function mapUser(n) {
  return {
    login: n.login, displayName: n.displayName, avatar: n.profileImageURL,
    title: (n.broadcastSettings && n.broadcastSettings.title) || '',
    live: n.stream ? { viewers: n.stream.viewersCount, startedAt: n.stream.createdAt, game: (n.stream.game && n.stream.game.displayName) || '' } : null
  };
}

const USER_FIELDS = 'login displayName profileImageURL(width: 70) broadcastSettings { title } stream { viewersCount createdAt game { displayName } }';
const Q_LIVE = `query { currentUser { login displayName profileImageURL(width: 70)
  followedLiveUsers(first: 100) { edges { node { ${USER_FIELDS} } } } } }`;
// Twitch's internal API changes now and then, so try a few shapes, newest first
const Q_SUBS = [
  `query { currentUser { subscriptionBenefits(first: 100, criteria: { filter: ALL }) { edges { node { tier endsAt renewsAt user { ${USER_FIELDS} } } } } } }`,
  `query { currentUser { subscriptionBenefits(first: 100) { edges { node { tier user { ${USER_FIELDS} } } } } } }`,
  `query { currentUser { subscriptionBenefits(first: 100) { edges { node { user { ${USER_FIELDS} } } } } } }`
];
let subs = [], subsError = null, subsAt = 0;

// Look up many channels at once (live status, title, avatar). This is the same lookup the
// channel header uses, which Twitch answers reliably. 30 channels per request.
async function fetchUsersBatch(logins) {
  logins = [...new Set(logins.filter(l => /^[a-z0-9_]{2,25}$/.test(l)))];
  const out = new Map();
  for (let i = 0; i < logins.length; i += 30) {
    const chunk = logins.slice(i, i + 30);
    const q = 'query { ' + chunk.map((l, k) => `u${k}: user(login: ${JSON.stringify(l)}) { ${USER_FIELDS} followers { totalCount } }`).join(' ') + ' }';
    try {
      const d = await gql(q);
      chunk.forEach((_, k) => { const u = d['u' + k]; if (u && u.login) out.set(u.login, { ...mapUser(u), followers: u.followers ? u.followers.totalCount : null }); });
    } catch (e) { dbg('batch lookup failed: ' + e.message); }
  }
  return out;
}

async function fetchFollows() {
  let after = null, all = [], user = null;
  for (let page = 0; page < 5; page++) {
    let d;
    try { d = await gql(Q_FOLLOWS, { c: after }); }
    catch (e) {
      if (page > 0) break;
      dbg('follows (paged) failed, trying simple: ' + e.message);
      d = await gql(Q_FOLLOWS_SIMPLE);
    }
    const cu = d.currentUser;
    if (!cu) throw new Error('Not logged in');
    user = { login: cu.login, displayName: cu.displayName, avatar: cu.profileImageURL };
    if (!cu.follows) break;
    for (const e of cu.follows.edges || []) { if (e && e.node) { all.push(mapUser(e.node)); after = e.cursor; } }
    if (!cu.follows.pageInfo || !cu.follows.pageInfo.hasNextPage) break;
  }
  return { user, all };
}
async function fetchLive() {
  const d = await gql(Q_LIVE);
  const cu = d.currentUser;
  if (!cu) throw new Error('Not logged in');
  const edges = (cu.followedLiveUsers && cu.followedLiveUsers.edges) || [];
  return {
    user: { login: cu.login, displayName: cu.displayName, avatar: cu.profileImageURL },
    live: edges.map(e => e && e.node).filter(Boolean).map(mapUser).filter(c => c.live)
  };
}
async function fetchSubsDirect() {
  let lastErr = null;
  for (const q of Q_SUBS) {
    try {
      const d = await gql(q);
      const cu = d.currentUser;
      if (!cu || !cu.subscriptionBenefits) throw new Error('No subscription data');
      return (cu.subscriptionBenefits.edges || []).map(e => e && e.node).filter(n => n && n.user).map(n => ({
        ...mapUser(n.user),
        tier: n.tier ? String(n.tier).replace(/^(\d)000$/, '$1') : null,
        renewsAt: n.renewsAt || null, endsAt: n.endsAt || null
      }));
    } catch (e) { lastErr = e; dbg('subs query shape failed: ' + e.message); }
  }
  throw lastErr || new Error('Could not load subscriptions');
}
// Backup: ask Twitch "am I subbed?" for every channel you follow or watched recently,
// the same check Twitch's own Subscribe button uses. 25 channels per request.
async function fetchSubsByChannel() {
  const logins = [...new Set([...follows.map(f => f.login), ...(settings.recent || [])])].filter(l => /^[a-z0-9_]{2,25}$/.test(l));
  if (!logins.length) return [];
  const out = [];
  for (let i = 0; i < logins.length; i += 25) {
    const chunk = logins.slice(i, i + 25);
    const q = 'query { ' + chunk.map((l, k) => `u${k}: user(login: ${JSON.stringify(l)}) { ${USER_FIELDS} self { subscriptionBenefit { tier renewsAt endsAt } } }`).join(' ') + ' }';
    let d;
    try { d = await gql(q); }
    catch (e) {
      // older field names: retry without the dates
      dbg('per-channel subs check failed: ' + e.message);
      const q2 = 'query { ' + chunk.map((l, k) => `u${k}: user(login: ${JSON.stringify(l)}) { ${USER_FIELDS} self { subscriptionBenefit { tier } } }`).join(' ') + ' }';
      d = await gql(q2);
    }
    chunk.forEach((_, k) => {
      const u = d['u' + k];
      const b = u && u.self && u.self.subscriptionBenefit;
      if (b) out.push({ ...mapUser(u), tier: b.tier ? String(b.tier).replace(/^(\d)000$/, '$1') : null, renewsAt: b.renewsAt || null, endsAt: b.endsAt || null });
    });
  }
  return out;
}
async function fetchSubs() {
  let direct = null, byChannel = null;
  try { direct = await fetchSubsDirect(); } catch {}
  try { byChannel = await fetchSubsByChannel(); } catch (e) { dbg('per-channel subs failed: ' + e.message); }
  if (!direct && !byChannel) throw new Error('Could not load subscriptions');
  const map = new Map();
  for (const c of [...(byChannel || []), ...(direct || [])]) map.set(c.login, { ...(map.get(c.login) || {}), ...c });
  const merged = [...map.values()];
  const fresh = await fetchUsersBatch(merged.map(c => c.login));
  for (const c of merged) { const u = fresh.get(c.login); if (u) map.set(c.login, { ...c, ...u, tier: c.tier, renewsAt: c.renewsAt, endsAt: c.endsAt }); }
  dbg('subs found: direct=' + (direct ? direct.length : 'failed') + ' perChannel=' + (byChannel ? byChannel.length : 'failed'));
  return [...map.values()];
}
async function refreshSubs(force) {
  if (!force && Date.now() - subsAt < 10 * 60 * 1000) return;
  subsAt = Date.now();
  try { subs = await fetchSubs(); subsError = null; }
  catch (e) { subsError = e.message; }
  send('subs', { subs, error: subsError });
}

// ---------- full follow list via Twitch's own Following page (hidden window) ----------
let sniffing = false, sniffAt = 0;
function sniffFollows(force) {
  if (sniffing || (!force && Date.now() - sniffAt < 30 * 60 * 1000)) return;
  sniffing = true; sniffAt = Date.now();
  const found = new Map();
  const w = new BrowserWindow({
    show: false, width: 1280, height: 1000,
    webPreferences: { partition: PARTITION, preload: path.join(__dirname, 'preload-sniff.js'),
      contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false }
  });
  w.webContents.setAudioMuted(true);
  const onData = (e, list) => { if (e.sender === w.webContents) for (const c of list || []) if (c && c.login) found.set(c.login, c); };
  ipcMain.on('sniff-follows', onData);
  const finish = () => {
    ipcMain.removeListener('sniff-follows', onData);
    if (!w.isDestroyed()) w.destroy();
    sniffing = false;
    dbg('follow list from Following page: ' + found.size + ' channels');
    if (found.size) {
      settings.followCache = [...found.values()];
      saveSettings();
      pollFollows();
    }
  };
  setTimeout(finish, 40000);
  w.loadURL('https://www.twitch.tv/directory/following/channels').catch(e => dbg('following page failed: ' + e.message));
}
function rememberFollow(login, on, extra) {
  const list = (settings.followCache || []).filter(c => c.login !== login);
  if (on) list.push({ login, displayName: (extra && extra.displayName) || login, avatar: (extra && extra.avatar) || null });
  settings.followCache = list;
  saveSettings();
}

async function pollFollows() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollFollows, 60000);
  if (!(await authToken())) {
    me = null; follows = []; liveSet = null; subs = []; subsAt = 0;
    send('follows', { me: null, follows: [] }); send('subs', { subs: [], error: null });
    return;
  }
  let user = null, all = null, live = null;
  try { const r = await fetchFollows(); user = r.user; all = r.all; } catch (e) { dbg('follows query failed: ' + e.message); }
  try { const r = await fetchLive(); user = user || r.user; live = r.live; } catch (e) { dbg('live query failed: ' + e.message); }
  // Twitch often returns an empty list to apps now. Fill in from Twitch's own Following page.
  if (!all || !all.length) {
    sniffFollows(false);
    const cache = (settings.followCache || []).map(c => ({ login: c.login, displayName: c.displayName || c.login, avatar: c.avatar || null, title: '', live: null }));
    if (cache.length) all = cache;
  }
  if (!all && !live) { send('follows-error', 'Could not load the channels you follow.'); return; }
  // Merge: the full follow list (if it loaded) plus the live list, which is the most reliable for "who's live"
  const map = new Map((all || []).map(c => [c.login, c]));
  if (live) {
    for (const c of map.values()) c.live = null;
    for (const c of live) map.set(c.login, { ...(map.get(c.login) || {}), ...c });
  }
  // Get the real live status for everyone you follow (the "live follows" list can come back empty)
  const fresh = await fetchUsersBatch([...map.keys()]);
  for (const [login, u] of fresh) {
    const prev = map.get(login) || {};
    map.set(login, { ...prev, ...u, live: u.live || (prev.live && live && live.some(x => x.login === login) ? prev.live : null) });
  }
  if (!user) { try { const d = await gql('query { currentUser { login displayName profileImageURL(width: 70) } }'); const cu = d.currentUser; if (cu) user = { login: cu.login, displayName: cu.displayName, avatar: cu.profileImageURL }; } catch {} }
  me = user; follows = [...map.values()];
  const nowLive = new Set(follows.filter(c => c.live).map(c => c.login));
  if (liveSet && settings.notify) {
    for (const c of follows) if (c.live && !liveSet.has(c.login) && !settings.muted.includes(c.login)) notifyLive(c);
  }
  liveSet = nowLive;
  send('follows', { me, follows, partial: !all });
  refreshSubs(false);
}

async function notifyLive(c) {
  if (!Notification.isSupported()) return;
  let icon = nativeImage.createFromPath(ICON);
  try { const r = await fetch(c.avatar); if (r.ok) icon = nativeImage.createFromBuffer(Buffer.from(await r.arrayBuffer())); } catch {}
  const n = new Notification({
    title: `${c.displayName} is live`,
    body: [c.live.game, c.title].filter(Boolean).join(': ').slice(0, 180),
    icon
  });
  n.on('click', () => { showWin(); send('open-channel', c.login); });
  n.on('close', () => { const i = liveNotes.indexOf(n); if (i >= 0) liveNotes.splice(i, 1); });
  liveNotes.push(n);
  if (liveNotes.length > 20) liveNotes.shift();
  n.show();
}

function socialToFirefox() {
  if (loginWin && !loginWin.isDestroyed()) loginWin.close();
  for (const w of BrowserWindow.getAllWindows()) if (w !== win && !w.isDestroyed()) w.close();
  if (socialToFirefox.busy) return;
  socialToFirefox.busy = true;
  setTimeout(() => { socialToFirefox.busy = false; }, 3000);
  send('ff-login-start');
}
function openLogin() {
  if (loginWin && !loginWin.isDestroyed()) return loginWin.focus();
  loginWin = new BrowserWindow({
    width: 520, height: 780, parent: win, autoHideMenuBar: true, title: 'Log in to Twitch', icon: ICON,
    webPreferences: { partition: PARTITION }
  });
  loginWin.webContents.on('will-navigate', (e, url) => { if (SOCIAL_RE.test(url)) { e.preventDefault(); socialToFirefox(); } });
  loginWin.webContents.on('will-redirect', (e, url) => { if (SOCIAL_RE.test(url)) { e.preventDefault(); socialToFirefox(); } });
  loginWin.loadURL('https://www.twitch.tv/login');
  loginWin.on('closed', () => { loginWin = null; });
}


// ---------- logging in through Firefox ----------
async function checkToken(token) {
  try { const d = await gql('query { currentUser { login } }', {}, token); return d.currentUser ? d.currentUser.login : null; }
  catch { return null; }
}
async function useToken(token) {
  token = String(token || '').trim().replace(/^OAuth\s+/i, '').replace(/^"|"$/g, '');
  if (!/^[a-z0-9]{20,40}$/i.test(token)) throw new Error('That does not look like an auth-token value.');
  // Check it first so a bad token never replaces (or removes) a working login
  const login = await checkToken(token);
  if (!login) throw new Error('Twitch did not accept that login.');
  if ((await authToken()) !== token) {
    await ses().cookies.set({
      url: 'https://www.twitch.tv', domain: '.twitch.tv', path: '/', name: 'auth-token', value: token,
      secure: true, sameSite: 'no_restriction', expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 3600
    });
  }
  return login;
}

// Reads Twitch's auth-token from Firefox's cookie database (normal, Flatpak, Snap and LibreWolf installs).
const FF_READER = `
import sqlite3, glob, os, shutil, tempfile, json
h = os.path.expanduser('~')
pats = [h+'/.mozilla/firefox/*/cookies.sqlite', h+'/.config/mozilla/firefox/*/cookies.sqlite',
        h+'/.var/app/org.mozilla.firefox/.mozilla/firefox/*/cookies.sqlite',
        h+'/.var/app/org.mozilla.firefox/config/mozilla/firefox/*/cookies.sqlite',
        h+'/snap/firefox/common/.mozilla/firefox/*/cookies.sqlite',
        h+'/.librewolf/*/cookies.sqlite', h+'/.var/app/io.gitlab.librewolf-community/.librewolf/*/cookies.sqlite']
out = []
for pat in pats:
    for f in glob.glob(pat):
        tmp = tempfile.mkdtemp()
        try:
            dst = os.path.join(tmp, 'cookies.sqlite')
            shutil.copy2(f, dst)
            if os.path.exists(f + '-wal'):
                shutil.copy2(f + '-wal', dst + '-wal')
            con = sqlite3.connect(dst)
            rows = con.execute("select name, value, host, path, expiry, isSecure, isHttpOnly, sameSite, lastAccessed from moz_cookies where host like '%twitch.tv'").fetchall()
            con.close()
            tok = [r for r in rows if r[0] == 'auth-token']
            if not tok:
                continue
            tok.sort(key=lambda r: r[8], reverse=True)
            out.append({'token': tok[0][1], 'seen': tok[0][8], 'cookies': [
                {'name': r[0], 'value': r[1], 'host': r[2], 'path': r[3] or '/', 'expiry': r[4],
                 'secure': bool(r[5]), 'httpOnly': bool(r[6]), 'sameSite': r[7]} for r in rows]})
        except Exception:
            pass
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
out.sort(key=lambda p: p['seen'], reverse=True)
print(json.dumps(out))
`;
function readFirefoxProfiles() {
  return new Promise(resolve => {
    const p = spawn('python3', ['-c', FF_READER], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => resolve([]));
    p.on('close', () => { try { resolve(JSON.parse(out.trim() || '[]')); } catch { resolve([]); } });
  });
}
function openInFirefox(url) {
  const flatpakFF = fs.existsSync(path.join(os.homedir(), '.var/app/org.mozilla.firefox'));
  const [cmd, args] = flatpakFF ? ['flatpak', ['run', 'org.mozilla.firefox', url]] : ['firefox', [url]];
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  p.on('error', () => shell.openExternal(url));
  p.unref();
}
let ffCancel = false;
// Copy Firefox's whole Twitch session (not just the login token) so Twitch's pages see a normal, consistent login
async function importCookies(list) {
  const SS = { 0: 'no_restriction', 1: 'lax', 2: 'strict' };
  for (const c of list) {
    let exp = Number(c.expiry) || 0;
    if (exp > 1e11) exp = Math.floor(exp / 1000); // newer Firefox stores milliseconds
    const host = String(c.host || '');
    const details = {
      url: 'https://' + host.replace(/^\./, '') + (c.path || '/'),
      name: c.name, value: c.value, path: c.path || '/',
      secure: !!c.secure, httpOnly: !!c.httpOnly
    };
    if (host.startsWith('.')) details.domain = host;
    let ss = SS[c.sameSite] || 'unspecified';
    if (ss === 'no_restriction' && !details.secure) ss = 'unspecified';
    details.sameSite = ss;
    if (exp > Date.now() / 1000) details.expirationDate = exp;
    try { await ses().cookies.set(details); } catch (e) { dbg('cookie import failed ' + c.name + ': ' + e.message); }
  }
}
async function firefoxLogin() {
  ffCancel = false;
  const tried = new Set();
  const tryAll = async () => {
    for (const p of await readFirefoxProfiles()) {
      if (tried.has(p.token)) continue;
      tried.add(p.token);
      const login = await checkToken(p.token);
      if (!login) continue;
      dbg('firefox login: importing ' + p.cookies.length + ' cookies for ' + login);
      await importCookies(p.cookies);
      return login;
    }
    return null;
  };
  // Already logged in to Twitch in Firefox? Then this is instant.
  let login = await tryAll();
  if (login) return login;
  openInFirefox('https://www.twitch.tv/login');
  const until = Date.now() + 5 * 60 * 1000;
  while (Date.now() < until && !ffCancel) {
    await new Promise(r => setTimeout(r, 3000));
    login = await tryAll();
    if (login) return login;
  }
  throw new Error(ffCancel ? 'Firefox login cancelled.' : 'Did not see a Twitch login in Firefox. Make sure you finish logging in there.');
}

// ---------- yt-dlp ----------
function ytdlpPath() {
  const c = [path.join(app.getPath('userData'), 'bin', 'yt-dlp')];
  for (const d of (process.env.PATH || '').split(':')) if (d) c.push(path.join(d, 'yt-dlp'));
  c.push(path.join(os.homedir(), '.local/bin/yt-dlp'), '/home/linuxbrew/.linuxbrew/bin/yt-dlp');
  return c.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}
async function installYtdlp() {
  const res = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux');
  if (!res.ok) throw new Error('Download failed (HTTP ' + res.status + ')');
  const dir = path.join(app.getPath('userData'), 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'yt-dlp');
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  fs.chmodSync(file, 0o755);
  return file;
}
const formatFor = q => (q === 'best' ? 'best' : `best[height<=${q}]/best`);
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}
const lastLine = s => String(s || '').trim().split('\n').filter(Boolean).pop() || '';

// ---------- live recording ----------
function startRec(channel) {
  channel = String(channel || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!channel) return;
  if (rec && rec.channel === channel && !rec.stopping) return;
  stopRec();
  const bin = ytdlpPath();
  if (!bin) return send('rec-update', { state: 'error', channel, msg: 'yt-dlp is not installed. Open Settings and press Install yt-dlp.' });
  fs.mkdirSync(settings.saveDir, { recursive: true });
  const base = path.join(settings.saveDir, `${channel}_live_${stamp()}`);
  const proc = spawn(bin, [`https://www.twitch.tv/${channel}`, '-f', formatFor(settings.recordQuality),
    '-o', base + '.%(ext)s', '--hls-use-mpegts', '--no-part', '--newline'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const me2 = { channel, proc, base, stopping: false, log: '' };
  rec = me2;
  const collect = d => { me2.log = (me2.log + d.toString()).slice(-4000); };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);
  proc.on('error', e => { me2.log += '\n' + e.message; });
  proc.on('close', code => {
    if (rec === me2) rec = null;
    let state = 'stopped', msg = '';
    if (!me2.stopping) {
      if (code === 0) state = 'ended';
      else if (/not currently live|is offline|does not exist/i.test(me2.log)) state = 'offline';
      else { state = 'error'; msg = lastLine(me2.log); }
    }
    try {
      const dir = path.dirname(base), b = path.basename(base);
      for (const f of fs.readdirSync(dir)) if (f.startsWith(b) && fs.statSync(path.join(dir, f)).size === 0) fs.unlinkSync(path.join(dir, f));
    } catch {}
    send('rec-update', { state, channel, msg });
  });
  send('rec-update', { state: 'recording', channel });
}
function stopRec() { if (rec && !rec.stopping) { rec.stopping = true; try { rec.proc.kill('SIGINT'); } catch {} } }

// ---------- VOD downloads ----------
function downloadVod(url) {
  if (!TWITCH_RE.test(url)) throw new Error('That is not a Twitch link.');
  const bin = ytdlpPath();
  if (!bin) throw new Error('yt-dlp is not installed. Open Settings and press Install yt-dlp.');
  fs.mkdirSync(settings.saveDir, { recursive: true });
  const id = String(Date.now());
  const out = path.join(settings.saveDir, '%(uploader)s_vod_%(upload_date)s_%(title).60s [%(id)s].%(ext)s');
  const proc = spawn(bin, [url, '-f', formatFor(settings.recordQuality), '-o', out, '--newline', '--no-mtime'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const d = { id, url, title: url, state: 'downloading', pct: 0 };
  let err = '', cancelled = false;
  downloads.set(id, { proc, cancel: () => { cancelled = true; try { proc.kill('SIGINT'); } catch {} } });
  proc.stdout.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) {
      const dest = /Destination:\s+(.*)$/.exec(line);
      if (dest) d.title = path.basename(dest[1]);
      const m = /\[download\]\s+([\d.]+)%/.exec(line);
      if (m) { d.pct = parseFloat(m[1]); send('dl-update', { ...d }); }
    }
  });
  proc.stderr.on('data', c => { err = (err + c.toString()).slice(-2000); });
  proc.on('error', e => { err += '\n' + e.message; });
  proc.on('close', code => {
    downloads.delete(id);
    d.state = code === 0 ? 'done' : (cancelled ? 'cancelled' : 'error');
    send('dl-update', { ...d, msg: d.state === 'error' ? lastLine(err) : '' });
  });
  send('dl-update', { ...d });
  return id;
}

function listSaved() {
  let files = [];
  try {
    files = fs.readdirSync(settings.saveDir).filter(f => VIDEO_EXT.test(f)).map(f => {
      const p = path.join(settings.saveDir, f), st = fs.statSync(p);
      return { name: f, path: p, size: st.size, mtime: st.mtimeMs, recording: !!(rec && p.startsWith(rec.base)) };
    });
  } catch {}
  return files.sort((a, b) => b.mtime - a.mtime);
}

async function setupBlocker() {
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    blocker = await ElectronBlocker.fromPrebuiltAdsOnly(fetch);
    if (settings.adblock) blocker.enableBlockingInSession(ses());
  } catch (e) { console.warn('[Twitch] Ghostery blocker unavailable:', e.message); }
}

// ---------- window + tray ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 900, minWidth: 980, minHeight: 600,
    backgroundColor: settings.theme === 'dark' ? '#17161c' : '#f4f4f7',
    title: 'Twitch', icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload-host.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true }
  });
  win.webContents.on('will-attach-webview', (e, wp, params) => {
    if (!TWITCH_RE.test(params.src || '')) { e.preventDefault(); return; }
    delete wp.preloadURL;
    wp.preload = path.join(__dirname, 'preload-twitch.js');
    wp.contextIsolation = false;
    wp.nodeIntegration = false;
    wp.sandbox = false;
    wp.backgroundThrottling = false;
  });
  win.on('close', e => { if (settings.background && !quitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
  win.loadFile('index.html');
}
function setupTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 22, height: 22 }));
    tray.setToolTip('Twitch');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open', click: showWin },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', showWin);
  } catch (e) { console.warn('tray unavailable', e.message); }
}

app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    if (SOCIAL_RE.test(url)) { socialToFirefox(); return { action: 'deny' }; }
    if (LOGIN_POPUP_RE.test(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 780, autoHideMenuBar: true, webPreferences: { partition: PARTITION } } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Catch Google/Apple/Amazon sign-in in ANY window or popup (Twitch opens a passport.twitch.tv
  // popup that then redirects to Google), and hand it to Firefox instead.
  if (wc.getType() === 'window') {
    const toFF = (e, url) => {
      if (!SOCIAL_RE.test(url) || (win && wc === win.webContents)) return;
      e.preventDefault();
      setImmediate(socialToFirefox);
    };
    wc.on('will-navigate', toFF);
    wc.on('will-redirect', (e, url, _inPlace, isMainFrame) => { if (isMainFrame !== false) toFF(e, url); });
  }
  if (wc.getType() === 'webview') {
    const tag = () => { const u = wc.getURL(); return /player\.twitch/.test(u) ? 'PLAYER' : /popout/.test(u) ? 'CHAT' : 'WEBVIEW'; };
    wc.on('did-start-navigation', (_e, url, inPlace, isMain) => { if (isMain && !inPlace) dbg(tag() + ' load ' + url); });
    wc.on('render-process-gone', (_e, d) => dbg(tag() + ' CRASHED ' + JSON.stringify(d)));
    wc.on('console-message', (_e, level, message) => {
      if (level >= 2 || /reload|logout|auth|integrity/i.test(message)) dbg(tag() + ' console[' + level + '] ' + String(message).slice(0, 300));
    });
    wc.on('will-navigate', (e, url) => {
      const ok = /^https:\/\/player\.twitch\.tv\//i.test(url) || /^https:\/\/www\.twitch\.tv\/popout\//i.test(url);
      if (!ok) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
    });
  }
});

// ---------- IPC ----------
const strip = e => String((e && e.message) || e);
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch = {}) => {
  Object.assign(settings, patch);
  saveSettings();
  if ('adblock' in patch && blocker) { try { settings.adblock ? blocker.enableBlockingInSession(ses()) : blocker.disableBlockingInSession(ses()); } catch {} }
  return settings;
});
ipcMain.on('twitch:boot', e => {
  let scripts = [];
  try {
    fs.mkdirSync(scriptsDir(), { recursive: true });
    scripts = fs.readdirSync(scriptsDir()).filter(f => f.endsWith('.js')).sort().map(f => fs.readFileSync(path.join(scriptsDir(), f), 'utf8'));
  } catch {}
  e.returnValue = { adblock: !!settings.adblock, quality: settings.quality, theme: settings.theme, scripts };
});

ipcMain.handle('dbg', (_e, m) => dbg('UI ' + String(m).slice(0, 300)));
ipcMain.handle('auth:login', () => openLogin());
ipcMain.handle('auth:token', (_e, token) => useToken(token));
ipcMain.handle('auth:firefox', () => firefoxLogin());
ipcMain.handle('auth:firefox-cancel', () => { ffCancel = true; });
ipcMain.handle('auth:logout', async () => {
  dbg('logout pressed'); await ses().clearStorageData(); me = null; follows = []; liveSet = null; subs = []; subsAt = 0; pollFollows(); });
ipcMain.handle('follows:get', () => ({ me, follows }));
ipcMain.handle('follow:state', async (_e, login) => {
  try {
    const d = await gql('query($l: String!) { user(login: $l) { id self { follower { followedAt } } } }', { l: login });
    const following = !!(d.user && d.user.self && d.user.self.follower);
    const inCache = (settings.followCache || []).some(c => c.login === login);
    if (following !== inCache) { rememberFollow(login, following); setTimeout(pollFollows, 500); }
    return { known: true, following };
  } catch (e) { dbg('follow state failed: ' + e.message); return { known: false, following: false }; }
});
ipcMain.handle('follow:set', async (_e, login, on) => {
  const d0 = await gql('query($l: String!) { user(login: $l) { id } }', { l: login });
  if (!d0.user) throw new Error('Channel not found');
  const id = d0.user.id;
  const m = on
    ? 'mutation($id: ID!) { followUser(input: { targetID: $id, disableNotifications: false }) { follow { followedAt } error { code } } }'
    : 'mutation($id: ID!) { unfollowUser(input: { targetID: $id }) { follow { followedAt } } }';
  let d;
  try { d = await gql(m, { id }); } catch (e) { dbg('follow mutation failed: ' + e.message); throw new Error('Twitch refused'); }
  const r = on ? d.followUser : d.unfollowUser;
  if (!r || (r.error && r.error.code)) { dbg('follow mutation refused: ' + JSON.stringify(r)); throw new Error('Twitch refused'); }
  rememberFollow(login, on);
  setTimeout(pollFollows, 1500);
  return true;
});
ipcMain.handle('subs:get', () => ({ subs, error: subsError }));
ipcMain.handle('subs:refresh', () => refreshSubs(true));
ipcMain.handle('open:firefox', (_e, url) => { if (TWITCH_RE.test(String(url))) openInFirefox(String(url)); });
ipcMain.handle('follows:refresh', () => { sniffFollows(true); return pollFollows(); });
ipcMain.handle('channel:info', async (_e, login) => {
  const d = await gql(Q_CHANNEL, { l: login });
  if (!d.user) return null;
  const u = d.user;
  return {
    ...mapUser(u),
    followers: u.followers ? u.followers.totalCount : null,
    game: (u.stream && u.stream.game && u.stream.game.displayName) || (u.broadcastSettings && u.broadcastSettings.game && u.broadcastSettings.game.displayName) || ''
  };
});
ipcMain.handle('channel:videos', async (_e, login) => {
  let d;
  try { d = await gql(Q_VIDEOS, { l: login }); } catch { d = await gql(Q_VIDEOS_ANY, { l: login }); }
  if (!d.user || !d.user.videos) return [];
  return d.user.videos.edges.map(e => e.node).filter(Boolean);
});
ipcMain.handle('search:channels', async (_e, q) => {
  q = String(q || '').trim().slice(0, 50);
  if (!q) return [];
  const F = `login displayName profileImageURL(width: 70) followers { totalCount } broadcastSettings { title } stream { viewersCount createdAt game { displayName } }`;
  const map = new Map();
  const add = u => { if (u && u.login && !map.has(u.login)) map.set(u.login, { ...mapUser(u), followers: u.followers ? u.followers.totalCount : null }); };
  // 1) exact channel name always works
  if (/^[a-z0-9_]{2,25}$/i.test(q)) {
    try { const d = await gql(`query($l: String!) { user(login: $l) { ${F} } }`, { l: q.toLowerCase() }); add(d.user); }
    catch (e) { dbg('search exact failed: ' + e.message); }
  }
  // 2) Twitch search (two shapes, Twitch changes these)
  const shapes = [
    [`query($q: String!) { searchUsers(userQuery: $q, first: 25) { edges { node { ${F} } } } }`, d => (d.searchUsers && d.searchUsers.edges || []).map(e => e && e.node)],
    [`query($q: String!) { searchFor(userQuery: $q, platform: "web", target: { index: CHANNEL, limit: 25 }) { channels { edges { item { ... on User { ${F} } } } } } }`,
      d => (d.searchFor && d.searchFor.channels && d.searchFor.channels.edges || []).map(e => e && e.item)]
  ];
  for (const [query, pick] of shapes) {
    try { const d = await gql(query, { q }); const list = pick(d).filter(Boolean); list.forEach(add); if (list.length) break; }
    catch (e) { dbg('search shape failed: ' + e.message); }
  }
  // search results often lack live info, so look them up properly
  const fresh = await fetchUsersBatch([...map.keys()]);
  for (const [login, u] of fresh) map.set(login, { ...map.get(login), ...u });
  // live channels first, then most followers
  return [...map.values()].sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || (b.followers || 0) - (a.followers || 0));
});
ipcMain.handle('explore:top', async () => {
  const d = await gql(Q_TOP);
  return ((d.streams && d.streams.edges) || []).map(e => e.node).filter(n => n && n.broadcaster).map(n => ({
    login: n.broadcaster.login, displayName: n.broadcaster.displayName, avatar: n.broadcaster.profileImageURL,
    title: (n.broadcaster.broadcastSettings && n.broadcaster.broadcastSettings.title) || '',
    viewers: n.viewersCount, game: (n.game && n.game.displayName) || '', thumb: n.previewImageURL
  }));
});

ipcMain.handle('rec:start', (_e, ch) => startRec(ch));
ipcMain.handle('rec:stop', () => stopRec());
ipcMain.handle('vod:download', (_e, url) => { try { return downloadVod(url); } catch (e) { throw new Error(strip(e)); } });
ipcMain.handle('vod:cancel', (_e, id) => { const d = downloads.get(id); if (d) d.cancel(); });
ipcMain.handle('saved:list', () => listSaved());
ipcMain.handle('saved:open', (_e, p) => (inSaveDir(p) ? shell.openPath(p) : 'Not in save folder'));
ipcMain.handle('saved:reveal', (_e, p) => { if (inSaveDir(p)) shell.showItemInFolder(p); });
ipcMain.handle('saved:delete', async (_e, p) => { if (inSaveDir(p)) await shell.trashItem(p); });
ipcMain.handle('saved:openDir', () => { fs.mkdirSync(settings.saveDir, { recursive: true }); return shell.openPath(settings.saveDir); });
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.saveDir });
  if (!r.canceled && r.filePaths[0]) { settings.saveDir = r.filePaths[0]; saveSettings(); }
  return settings;
});
ipcMain.handle('ytdlp:status', () => ytdlpPath());
ipcMain.handle('ytdlp:install', () => installYtdlp());
ipcMain.handle('scripts:openDir', () => { fs.mkdirSync(scriptsDir(), { recursive: true }); return shell.openPath(scriptsDir()); });
ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWin);
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    loadSettings();
    const s = ses();
    s.setUserAgent(s.getUserAgent().replace(/\s*Electron\/\S+/i, '').replace(/\s*Twitch\/\S+/i, ''));
    let authTimer;
    authToken().then(t => { knownToken = t; });
    s.cookies.on('changed', (_e, cookie, _cause, removed) => {
      if (cookie.name !== 'auth-token') return;
      if (!removed && loginWin && !loginWin.isDestroyed()) loginWin.close();
      clearTimeout(authTimer);
      authTimer = setTimeout(async () => {
        subsAt = 0;
        // Twitch's pages re-save the same login cookie every time they load.
        // Only react when the login actually changed, or chat/player would reload forever.
        const now = await authToken();
        if (now === knownToken) return;
        dbg('login changed: ' + (knownToken ? 'had token' : 'none') + ' -> ' + (now ? 'token' : 'none'));
        knownToken = now;
        liveSet = null;
        send('auth-changed');
        pollFollows();
      }, 800);
    });
    setupBlocker();
    createWindow();
    setupTray();
    pollFollows();
  });
}
app.on('before-quit', () => {
  quitting = true;
  stopRec();
  for (const d of downloads.values()) d.cancel();
});
app.on('window-all-closed', () => { if (!settings.background || quitting) app.quit(); });
