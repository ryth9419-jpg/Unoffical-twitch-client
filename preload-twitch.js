// Runs inside the Twitch page before Twitch's own scripts.
// Adds: video-ad stripping, latency tracking, auto jump to live, smooth catch-up, user scripts.
const { ipcRenderer, webFrame } = require('electron');

let boot = { adblock: false, quality: 'auto', scripts: [] };
try { boot = ipcRenderer.sendSync('twitch:boot') || boot; } catch {}

// ---------- player preferences ----------
try {
  localStorage.setItem('lowLatencyModeEnabled', 'true');
  localStorage.setItem('twilight.theme', boot.theme === 'dark' ? '1' : '0');
  if (boot.quality && boot.quality !== 'auto') {
    localStorage.setItem('video-quality', JSON.stringify({ default: boot.quality }));
  } else {
    localStorage.removeItem('video-quality');
  }
} catch {}

// ---------- video ad stripping ----------
// Twitch stitches ads into the HLS playlist. Live segments are tagged ",live";
// stitched ad segments are not. We drop the ad segments so the player never gets them.
function twwStripAds(text) {
  if (text.indexOf('#EXTINF') === -1 || !/stitched|twitch-ad/i.test(text)) return { text, removed: 0 };
  const header = [], kept = [];
  let block = [], inSegs = false, seq = 0, seqIdx = -1, idx = 0, firstKept = -1, removed = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { seq = parseInt(line.split(':')[1], 10) || 0; seqIdx = header.length; header.push(line); continue; }
    if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) continue;
    if (line.startsWith('#EXT-X-DATERANGE') && /stitched|twitch-ad/i.test(line)) continue;
    if (/^#EXTINF|^#EXT-X-PROGRAM-DATE-TIME|^#EXT-X-DISCONTINUITY/.test(line)) { inSegs = true; block.push(line); continue; }
    if (inSegs && line && !line.startsWith('#')) {
      block.push(line);
      const inf = block.find(l => l.startsWith('#EXTINF')) || '';
      if (inf.indexOf(',live') === -1) removed++;
      else { if (firstKept < 0) firstKept = idx; kept.push(...block); }
      idx++; block = [];
      continue;
    }
    if (inSegs) block.push(line); else header.push(line);
  }
  if (!removed) return { text, removed: 0 };
  if (seqIdx >= 0) header[seqIdx] = '#EXT-X-MEDIA-SEQUENCE:' + (seq + (firstKept < 0 ? idx : firstKept));
  return { text: header.concat(kept).join('\n') + '\n', removed };
}

function twwWorkerPrelude() {
  const realFetch = self.fetch;
  self.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const res = await realFetch(input, init);
    if (!/\.m3u8/i.test(url) || !/ttvnw\.net|twitch\.tv|live-video\.net/i.test(url)) return res;
    try {
      const body = await res.clone().text();
      const out = twwStripAds(body);
      if (!out.removed) return res;
      self.postMessage({ __tww: 'ad', removed: out.removed });
      const h = new Headers(res.headers);
      h.delete('content-length');
      h.delete('content-encoding');
      return new Response(out.text, { status: res.status, statusText: res.statusText, headers: h });
    } catch (e) {
      return res;
    }
  };
}

if (boot.adblock) {
  const prelude = twwStripAds.toString() + '\n(' + twwWorkerPrelude.toString() + ')();\n';
  const RealWorker = window.Worker;
  window.Worker = class Worker extends RealWorker {
    constructor(url, options) {
      let target = url;
      try {
        if (!(options && options.type === 'module')) {
          const abs = new URL(String(url), location.href).href;
          const blob = new Blob([prelude + 'importScripts(' + JSON.stringify(abs) + ');'], { type: 'text/javascript' });
          target = URL.createObjectURL(blob);
        }
      } catch (e) { target = url; }
      super(target, options);
      this.addEventListener('message', ev => {
        const d = ev.data;
        if (d && d.__tww === 'ad') {
          ev.stopImmediatePropagation();
          ipcRenderer.sendToHost('ad', { removed: d.removed });
        }
      });
    }
  };
}

// ---------- user scripts (~/.config/TwitchWatch/scripts/*.js) ----------
for (const code of boot.scripts || []) {
  webFrame.executeJavaScript(code).catch(e => console.warn('[TwitchWatch] user script error', e));
}

// ---------- latency + auto-live ----------
const RESERVED = new Set(['directory', 'videos', 'settings', 'search', 'downloads', 'subscriptions', 'inventory',
  'wallet', 'drops', 'p', 'jobs', 'turbo', 'prime', 'friends', 'messages', 'following', 'payments', 'u',
  'moderator', 'popout', 'login', 'signup', 'store', 'bits', 'logout', 'team', 'event', 'collections',
  'clip', 'clips', 'dashboard', 'broadcast', 'annual-recap', 'activate']);

function onChannelPage() {
  if (location.hostname === 'player.twitch.tv') return new URLSearchParams(location.search).has('channel');
  const parts = location.pathname.split('/').filter(Boolean);
  return parts.length === 1 && !RESERVED.has(parts[0].toLowerCase());
}
function findVideo() {
  const vids = Array.from(document.querySelectorAll('video'));
  return vids.find(v => v.readyState >= 2 && !v.paused) || vids.find(v => v.readyState >= 2) || null;
}
const edgeOf = v => (v.buffered.length ? v.buffered.end(v.buffered.length - 1) : v.currentTime);

let cfg = { autoLive: true, threshold: 6, catchUp: true };
let lastWaiting = 0;
document.addEventListener('waiting', () => { lastWaiting = performance.now(); }, true);
let base = null, lastLag = 0, lastJump = 0, lastReload = 0, weSetRate = false, sentNull = false;

ipcRenderer.on('cfg', (_e, c) => { cfg = Object.assign(cfg, c || {}); });
ipcRenderer.on('cmd', (_e, cmd) => {
  const v = findVideo();
  if (v && cmd === 'golive') goLive(v, true);
});

function goLive(v, manual) {
  const edge = edgeOf(v);
  if (edge - v.currentTime > 2.5) v.currentTime = edge - 1.5;
  if (v.paused) v.play().catch(() => {});
  lastJump = performance.now();
  // Only when YOU click the badge: if seeking didn't get us close to live
  // (e.g. after a long pause), reload the player once to fetch the real live edge.
  if (manual) {
    setTimeout(() => {
      if (lastLag > Math.max(cfg.threshold, 4) && performance.now() - lastReload > 30000) {
        lastReload = performance.now();
        location.reload();
      }
    }, 4000);
  }
}

setInterval(() => {
  const v = onChannelPage() ? findVideo() : null;
  if (!v) {
    base = null;
    if (!sentNull) { ipcRenderer.sendToHost('lat', null); sentNull = true; }
    return;
  }
  sentNull = false;
  const now = performance.now() / 1000;
  const bufLag = Math.max(0, edgeOf(v) - v.currentTime);
  if (!base || base.v !== v || v.currentTime < base.ct - 2) base = { v, wall: now, ct: v.currentTime, lag: bufLag };
  // lag = starting buffer + real time passed - video time played
  let lag = base.lag + (now - base.wall) - (v.currentTime - base.ct);
  if (lag < bufLag) { base = { v, wall: now, ct: v.currentTime, lag: bufLag }; lag = bufLag; }
  lastLag = lag;

  // Only act on video that is actually sitting in the buffer. If the lag comes from stalls,
  // seeking or speeding up just empties the buffer and causes a loading screen.
  const healthy = !v.paused && !v.seeking && v.readyState >= 3 && performance.now() - lastWaiting > 4000;
  if (healthy) {
    if (cfg.autoLive && lag > cfg.threshold && bufLag > 3 && performance.now() - lastJump > 8000) {
      goLive(v);
    } else if (cfg.catchUp) {
      if (bufLag > 3 && v.playbackRate === 1) { v.playbackRate = 1.1; weSetRate = true; }
      else if (weSetRate && bufLag < 2) { v.playbackRate = 1; weSetRate = false; }
    } else if (weSetRate) { v.playbackRate = 1; weSetRate = false; }
  } else if (weSetRate && v.readyState < 3) { v.playbackRate = 1; weSetRate = false; }
  ipcRenderer.sendToHost('lat', { lag, rate: v.playbackRate, paused: v.paused });
}, 500);


// ---------- polls & predictions (chat page only) ----------
if (location.pathname.includes('/popout/') && location.pathname.endsWith('/chat')) {
  const findCards = () => Array.from(document.querySelectorAll('[class*="community-highlight"]'))
    .filter(el => /poll|prediction|predict|vote/i.test(el.innerText || ''))
    .filter(el => !el.parentElement || !el.parentElement.closest('[class*="community-highlight"]') ||
      !/poll|prediction|predict|vote/i.test(el.parentElement.closest('[class*="community-highlight"]').innerText || ''));
  let lastSent = '';
  const report = () => {
    const card = findCards()[0];
    let msg = null;
    if (card) {
      const text = (card.innerText || '').replace(/\s+/g, ' ').trim();
      const kind = /predict/i.test(text) ? 'prediction' : 'poll';
      msg = { kind, text: text.slice(0, 140) };
    }
    const key = JSON.stringify(msg);
    if (key !== lastSent) { lastSent = key; ipcRenderer.sendToHost('poll', msg); }
  };
  const start = () => {
    new MutationObserver(() => { clearTimeout(start.t); start.t = setTimeout(report, 400); })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
    report();
    // Make the poll / prediction banner stand out
    const st = document.createElement('style');
    st.textContent = '[class*="community-highlight"]{outline:3px solid #7c3aed !important;outline-offset:-3px;border-radius:8px}';
    document.head.appendChild(st);
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  ipcRenderer.on('cmd', (_e, cmd) => {
    if (cmd !== 'open-poll') return;
    const card = findCards()[0];
    if (!card) return;
    card.scrollIntoView({ block: 'start' });
    const btn = card.querySelector('button[aria-expanded="false"], button');
    if (btn) btn.click();
  });
}
