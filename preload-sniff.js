// Runs in a hidden window on Twitch's "Following" page. Twitch's own page loads your full
// follow list (its own app is allowed to); we just read the list out of those replies.
const { ipcRenderer } = require('electron');

function collect(obj, out, depth) {
  if (!obj || typeof obj !== 'object' || depth > 14) return;
  if (Array.isArray(obj)) { for (const x of obj) collect(x, out, depth + 1); return; }
  for (const [k, v] of Object.entries(obj)) {
    if (/^(follows|followedChannels|followedUsers)$/.test(k) && v && Array.isArray(v.edges)) {
      for (const e of v.edges) {
        const n = e && (e.node || e.user);
        if (n && n.login) out.push({ login: String(n.login).toLowerCase(), displayName: n.displayName || n.login, avatar: n.profileImageURL || null });
      }
    } else collect(v, out, depth + 1);
  }
}

const realFetch = window.fetch;
window.fetch = async function (input, init) {
  const res = await realFetch.apply(this, arguments);
  try {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/gql\.twitch\.tv/.test(url)) {
      res.clone().json().then(j => {
        const out = [];
        collect(j, out, 0);
        if (out.length) ipcRenderer.send('sniff-follows', out);
      }).catch(() => {});
    }
  } catch {}
  return res;
};

// Keep scrolling so Twitch loads the whole list, not just the first page
let ticks = 0;
const timer = setInterval(() => {
  ticks++;
  document.querySelectorAll('.simplebar-scroll-content, [data-a-target="root-scroller"], main, .scrollable-area')
    .forEach(e => { try { e.scrollTop = e.scrollHeight; } catch {} });
  try { window.scrollTo(0, document.body.scrollHeight); } catch {}
  if (ticks > 45) clearInterval(timer);
}, 800);
