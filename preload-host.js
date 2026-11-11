// Bridge between the app UI (index.html) and the main process
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['rec-update', 'dl-update', 'follows', 'follows-error', 'auth-changed', 'open-channel', 'ff-login-start', 'subs'];
const call = ch => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('tw', {
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  login: call('auth:login'),
  logout: call('auth:logout'),
  loginToken: call('auth:token'),
  loginFirefox: call('auth:firefox'),
  cancelFirefox: call('auth:firefox-cancel'),
  getFollows: call('follows:get'),
  refreshFollows: call('follows:refresh'),
  getSubs: call('subs:get'),
  followState: call('follow:state'),
  setFollow: call('follow:set'),
  refreshSubs: call('subs:refresh'),
  openFirefox: call('open:firefox'),
  channelInfo: call('channel:info'),
  channelVideos: call('channel:videos'),
  exploreTop: call('explore:top'),
  searchChannels: call('search:channels'),
  recStart: call('rec:start'),
  recStop: call('rec:stop'),
  vodDownload: call('vod:download'),
  vodCancel: call('vod:cancel'),
  savedList: call('saved:list'),
  savedOpen: call('saved:open'),
  savedReveal: call('saved:reveal'),
  savedDelete: call('saved:delete'),
  openSaveDir: call('saved:openDir'),
  pickFolder: call('pick-folder'),
  ytdlpStatus: call('ytdlp:status'),
  ytdlpInstall: call('ytdlp:install'),
  openScriptsDir: call('scripts:openDir'),
  quit: call('app:quit'),
  log: call('dbg'),
  on: (ch, fn) => { if (EVENTS.includes(ch)) ipcRenderer.on(ch, (_e, d) => fn(d)); }
});
