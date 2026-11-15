// HomeFlix control panel. Talks only to the loopback control server, using the
// endpoints and shapes in docs/ARCHITECTURE.md.

const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', '3gp'];
const PHOTO_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp'];
const ALLOWED = new Set([...VIDEO_EXT, ...PHOTO_EXT]);

const STATUS_EVERY = 2000;
const MAX_UPLOADS = 2;
const CHUNK = 60;

const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  online: true,
  misses: 0,
  pending: null,        // "starting" | "stopping" | null
  startError: null,     // { code, message } from the last failed attempt to turn on
  items: [],
  collections: [],
  libraryKey: '',
  libraryLoaded: false,
  filter: { kind: 'all', collection: '', q: '' },
  shown: CHUNK,
  visible: [],          // items after filtering, in display order
  gridKey: '',
  jobs: [],
  jobStates: new Map(),
  hiddenJobs: new Set(),
  uploads: [],
  uploadSeq: 0,
  picking: false,
  viewerId: null,
};

/* ───────── helpers ───────── */

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v; // only ever used with constant strings in this file
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid);
  }
  return el;
}

class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      cache: 'no-store',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('HomeFlix isn’t answering. Check that it is still open on this Mac.', 'offline', 0);
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    throw new ApiError(
      (data && data.error) || 'Something went wrong. Try again in a moment.',
      (data && data.code) || 'unknown',
      res.status,
    );
  }
  return data;
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  const digits = i <= 1 || n >= 100 ? 0 : 1;
  return `${n.toFixed(digits)} ${units[i]}`;
}

function fmtDuration(s) {
  if (!Number.isFinite(s) || s <= 0) return '';
  s = Math.round(s);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function fmtRemaining(s) {
  if (!Number.isFinite(s)) return '';
  if (s < 5) return 'a few seconds left';
  if (s < 60) return `${Math.round(s)} seconds left`;
  if (s < 3600) return `about ${Math.round(s / 60)} min left`;
  return `about ${(s / 3600).toFixed(1)} hours left`;
}

function fmtAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 15) return 'active now';
  if (s < 90) return 'active a moment ago';
  return `active ${Math.round(s / 60)} min ago`;
}

function plural(n, one, many) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function deviceName(ua) {
  ua = ua || '';
  if (/web0s|webos|netcast/i.test(ua)) return 'LG TV';
  if (/tizen|smart-tv|smarttv.*samsung|samsung.*smarttv/i.test(ua)) return 'Samsung TV';
  if (/bravia|sony/i.test(ua)) return 'Sony TV';
  if (/aft[a-z0-9]+|fire tv/i.test(ua)) return 'Fire TV';
  if (/android tv|googletv|chromecast/i.test(ua)) return 'Android TV';
  if (/philips|nettv/i.test(ua)) return 'Philips TV';
  if (/hisense|vidaa/i.test(ua)) return 'Hisense TV';
  if (/roku/i.test(ua)) return 'Roku';
  if (/playstation/i.test(ua)) return 'PlayStation';
  if (/xbox/i.test(ua)) return 'Xbox';
  if (/smart-?tv|hbbtv|\btv\b/i.test(ua)) return 'Smart TV';
  if (/iphone/i.test(ua)) return 'iPhone';
  if (/ipad/i.test(ua)) return 'iPad';
  if (/android/i.test(ua)) return 'Android phone or tablet';
  if (/macintosh|windows|linux/i.test(ua)) return 'Computer';
  return 'Device';
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* private window: carry on without remembering */ }
  return null;
}

function toast(message, bad) {
  const el = h('div', { class: bad ? 'toast bad' : 'toast', text: message });
  $('toasts').append(el);
  setTimeout(() => el.remove(), bad ? 9000 : 4500);
}

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* nothing more to try */ }
    ta.remove();
  }
  toast(done);
}

function confirmDialog({ title, text, yes }) {
  const dlg = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-yes').textContent = yes;
  dlg.returnValue = 'cancel';
  dlg.showModal();
  $('confirm-no').focus();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

const ICON = {
  play: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1l9 5-9 5z"/></svg>',
  folder: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5a1.5 1.5 0 011.5-1.5h3.6l1.8 2H16a1.5 1.5 0 011.5 1.5v7A1.5 1.5 0 0116 16H4a1.5 1.5 0 01-1.5-1.5z"/></svg>',
  trash: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5h13M8 5.5V3.8h4v1.7M5.2 5.5l.8 11h8l.8-11M8.3 8.5v5M11.7 8.5v5"/></svg>',
};

/* ───────── status ───────── */

async function pollStatus() {
  try {
    const s = await api('GET', '/api/status');
    state.misses = 0;
    setOnline(true);
    applyStatus(s);
  } catch (err) {
    if (err.code === 'offline' || err.status >= 500) {
      state.misses++;
      if (state.misses >= 2) setOnline(false);
    }
  } finally {
    setTimeout(pollStatus, STATUS_EVERY);
  }
}

function setOnline(online) {
  if (state.online === online) return;
  state.online = online;
  $('banner').hidden = online;
  $('main').inert = !online;
  if (online) {
    state.libraryKey = '';
    pollJobs(true);
  } else {
    state.pending = null;
  }
  renderPower();
}

function applyStatus(s) {
  state.status = s;
  if (state.pending === 'starting' && s.running) state.pending = null;
  if (s.running) state.startError = null;

  const key = [s.counts.videos, s.counts.photos, s.counts.bytes, s.scanning, s.config.libraryFolder, s.config.extraFolders.join('|')].join('/');
  if (key !== state.libraryKey) {
    state.libraryKey = key;
    loadLibrary();
  }

  document.title = s.running ? `${s.name} · On air` : s.name;
  renderPower();
  renderStage();
  renderJourney();
  renderLibraryHead();
  renderGrid();
  renderFolders();
  renderSettings();
  renderHelp();
}

function powerView() {
  const s = state.status;
  if (!state.online) return { pill: 'Closed', pillState: 'bad', view: 'wait' };
  if (!s) return { pill: 'Checking', pillState: 'wait', view: 'wait' };
  if (state.pending === 'starting') return { pill: 'Starting', pillState: 'busy', view: 'busy' };
  if (state.pending === 'stopping') return { pill: 'Stopping', pillState: 'busy', view: 'busy' };
  if (s.running) {
    if (!s.url) return { pill: 'Problem', pillState: 'bad', view: 'nonet' };
    return { pill: 'On air', pillState: 'on', view: 'on' };
  }
  if (state.startError || s.error) return { pill: 'Problem', pillState: 'bad', view: 'problem' };
  return { pill: 'Off', pillState: 'off', view: 'off' };
}

function renderPower() {
  const v = powerView();
  const s = state.status;
  const sw = $('switch');
  $('pill').dataset.state = v.pillState;
  $('pill-text').textContent = v.pill;
  const on = !!(s && s.running) && state.pending !== 'stopping';
  sw.setAttribute('aria-checked', String(state.pending === 'starting' ? true : on));
  sw.toggleAttribute('data-busy', !!state.pending);
  sw.disabled = !s || !state.online || !!state.pending;
  sw.title = state.pending ? 'One moment…' : on ? 'Turn off' : 'Turn on';
}

async function setPower(on) {
  if (state.pending || !state.status) return;
  state.pending = on ? 'starting' : 'stopping';
  state.startError = null;
  renderPower();
  renderStage();
  try {
    const s = await api('POST', on ? '/api/server/start' : '/api/server/stop');
    state.pending = null;
    applyStatus(s);
    if (on && s.running) $('connect').scrollIntoView({ block: 'nearest' });
  } catch (err) {
    state.pending = null;
    if (on) state.startError = { code: err.code, message: err.message };
    else toast(err.message, true);
    renderPower();
    renderStage();
    renderJourney();
  }
}

function togglePower() {
  const s = state.status;
  if (!s) return;
  setPower(!s.running);
}

let stageKey = '';
function renderStage() {
  const s = state.status;
  const v = powerView();
  const stage = $('connect');
  const key = JSON.stringify([
    v.view, state.pending, state.startError,
    s && [s.url, s.altUrls, s.wifiName, s.qrSvg && s.qrSvg.length, s.port, s.config.port, s.error, s.name,
      s.clients.map((c) => [c.address, c.userAgent, Math.round((Date.now() - c.lastSeen) / 30000)])],
  ]);
  if (key === stageKey) return;
  stageKey = key;

  stage.dataset.view = v.view === 'problem' ? 'off' : v.view;
  const live = v.view === 'on';
  $('stage-live').hidden = !live;
  $('stage-nonet').hidden = v.view !== 'nonet';
  $('stage-idle').hidden = live || v.view === 'nonet';
  if (!s) return;

  if (!live && v.view !== 'nonet') {
    const title = $('stage-title');
    const sub = $('stage-sub');
    const problem = $('stage-problem');
    const btn = $('stage-on');
    problem.hidden = true;
    btn.hidden = true;
    if (v.view === 'busy') {
      title.textContent = state.pending === 'starting' ? 'Turning on…' : 'Turning off…';
      sub.textContent = state.pending === 'starting' ? 'Getting ready for your TV.' : 'One moment.';
    } else if (v.view === 'problem') {
      title.textContent = 'HomeFlix couldn’t turn on';
      sub.textContent = '';
      const err = state.startError || { code: 'error', message: s.error };
      const portBusy = err.code === 'port_in_use';
      const port = s.config.port;
      $('stage-problem-text').textContent = portBusy
        ? `Another app on this Mac is already using port ${port}, and the next few numbers are taken too. Choose a different port number in Settings, for example ${port >= 8000 && port < 60000 ? port + 800 : 8888}, then turn HomeFlix on again.`
        : `${err.message} Try turning it on again. If it keeps happening, close HomeFlix and open it again.`;
      $('stage-problem-fix').hidden = !portBusy;
      problem.hidden = false;
      btn.hidden = false;
      btn.textContent = 'Try again';
    } else {
      title.textContent = `${s.name} is off`;
      sub.textContent = 'Turn it on to connect your TV and play the videos and photos on this Mac. Everything stays on your home Wi-Fi.';
      btn.hidden = false;
      btn.textContent = 'Turn on';
    }
    return;
  }
  if (!live) return;

  $('addr-host').textContent = s.url.replace(/^http:\/\//, '');
  $('addr').querySelector('.addr-scheme').hidden = !s.url.startsWith('http://');
  fitAddress();

  const wifi = $('wifi');
  wifi.hidden = !s.wifiName;
  wifi.replaceChildren('This Mac is on Wi-Fi ', h('strong', { text: s.wifiName || '' }));
  $('wifi-step').replaceChildren(...(s.wifiName ? [', ', h('strong', { text: s.wifiName })] : []));

  const portNote = $('port-note');
  portNote.hidden = s.port === s.config.port;
  portNote.textContent = `Port ${s.config.port} was being used by another app, so HomeFlix is using ${s.port} this time. The address above is already correct.`;
  const liveErr = $('live-error');
  liveErr.hidden = !s.error;
  liveErr.textContent = s.error || '';

  const alts = (s.altUrls || []).filter((u) => u !== s.url);
  $('alt').hidden = !alts.length;
  $('alt-list').replaceChildren(...alts.map((u) => h('li', { text: u })));

  const qr = $('qr');
  qr.hidden = !s.qrSvg;
  if (s.qrSvg) {
    // As an image, so nothing inside the SVG can run or restyle the page.
    $('qr-img').src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s.qrSvg);
  }

  const list = $('clients');
  if (!s.clients.length) {
    list.replaceChildren(h('li', { class: 'none' }, h('span', null, 'No TV yet. It will show up here as soon as it opens the address.')));
  } else {
    list.replaceChildren(...s.clients.map((c) =>
      h('li', null, h('span', null, deviceName(c.userAgent), h('small', { text: `${c.address}, ${fmtAgo(c.lastSeen)}` })))));
  }
}

/* Keep the whole address on one line: shrink the type until it fits its column. */
function fitAddress() {
  const el = $('addr');
  if (!el.offsetParent) return;
  el.style.fontSize = '';
  el.style.whiteSpace = '';
  let size = parseFloat(getComputedStyle(el).fontSize);
  while (el.scrollWidth > el.clientWidth && size > 20) {
    size -= 2;
    el.style.fontSize = `${size}px`;
  }
  if (el.scrollWidth > el.clientWidth) el.style.whiteSpace = 'normal';
}

function renderJourney() {
  const s = state.status;
  const el = $('journey');
  if (!s) return;
  const uploaded = state.uploads.some((u) => u.state === 'done');
  const done1 = s.counts.videos + s.counts.photos > 0 || uploaded;
  const done2 = s.running;
  const done3 = s.clients.length > 0;
  if (done1 && done2 && done3) store('homeflix.started', '1');
  if (store('homeflix.started') === '1') { el.hidden = true; return; }
  el.hidden = false;
  const steps = [done1, done2, done3];
  const now = steps.indexOf(false);
  steps.forEach((done, i) => {
    $(`j${i + 1}`).dataset.state = done ? 'done' : i === now ? 'now' : 'next';
  });
  $('j1-sub').textContent = done1
    ? `${plural(s.counts.videos, 'video', 'videos')} and ${plural(s.counts.photos, 'photo', 'photos')} ready.`
    : 'Drop them on this page, or choose them.';
  $('j2-sub').textContent = done2 ? 'HomeFlix is on air.' : 'Lets your TV see them.';
  $('j3-sub').textContent = done3
    ? 'Your TV is connected.'
    : done2 && s.url ? 'Type the address above into the TV’s web browser.' : 'Type the address into the TV’s web browser.';
}

/* ───────── library ───────── */

let libraryBusy = false;
let libraryAgain = false;
let libraryTimer = 0;

function refreshLibrarySoon(ms = 500) {
  clearTimeout(libraryTimer);
  libraryTimer = setTimeout(loadLibrary, ms);
}

async function loadLibrary() {
  if (libraryBusy) { libraryAgain = true; return; }
  libraryBusy = true;
  try {
    const lib = await api('GET', '/api/library');
    state.items = [...lib.videos, ...lib.photos].sort((a, b) => b.mtime - a.mtime);
    state.collections = lib.collections || [];
    state.libraryLoaded = true;
    renderCollections();
    renderGrid();
    if (state.viewerId && !state.items.some((i) => i.id === state.viewerId)) closeViewer();
  } catch { /* the status poll reports a lost server; the next change retries */ }
  libraryBusy = false;
  if (libraryAgain) { libraryAgain = false; loadLibrary(); }
}

function renderLibraryHead() {
  const s = state.status;
  const { videos, photos, bytes } = s.counts;
  $('lib-counts').textContent = videos + photos === 0
    ? 'No videos or photos yet.'
    : `${plural(videos, 'video', 'videos')}, ${plural(photos, 'photo', 'photos')}, ${fmtBytes(bytes)} in total`;
  $('scanning').hidden = !s.scanning;
  // A missing or unreadable folder is its own notice; it has nothing to do with on/off.
  const libErr = s.libraryError || '';
  const advice = 'If it is on an external drive, plug the drive back in and it will come back by itself. Otherwise choose another folder under Folders.';
  $('lib-error').hidden = !libErr;
  $('lib-error-text').textContent = libErr ? `${libErr} ${advice}` : '';
  $('fold-error').hidden = !libErr;
  $('fold-error').textContent = libErr ? `${libErr} Reconnect the drive, or use Change… or Remove below.` : '';
  $('ffmpeg-hint').hidden = s.tools.ffmpeg || store('homeflix.ffmpegHint') === 'hidden';
}

function renderCollections() {
  const names = state.collections.map((c) => c.name);
  $('collection-list').replaceChildren(...names.map((n) => h('option', { value: n })));
  const sel = $('f-collection');
  if (state.filter.collection && !names.includes(state.filter.collection)) state.filter.collection = '';
  sel.replaceChildren(
    h('option', { value: '', text: 'All albums and folders' }),
    ...state.collections.map((c) => h('option', { value: c.name, text: `${c.name} (${c.videos + c.photos})` })),
  );
  sel.value = state.filter.collection;
}

function filteredItems() {
  const { kind, collection, q } = state.filter;
  const needle = q.trim().toLowerCase();
  return state.items.filter((i) =>
    (kind === 'all' || i.kind === kind) &&
    (!collection || i.collection === collection) &&
    (!needle || i.title.toLowerCase().includes(needle) || i.file.toLowerCase().includes(needle)));
}

function jobFor(itemId) {
  return state.jobs.find((j) => j.itemId === itemId && (j.state === 'queued' || j.state === 'running'));
}

function renderGrid(resetShown) {
  if (!state.libraryLoaded) return;
  const grid = $('grid');
  const total = state.items.length;
  const f = state.filter;
  if (resetShown) state.shown = CHUNK;

  $('empty').hidden = total > 0;
  $('filters').hidden = total === 0;

  const list = filteredItems();
  state.visible = list;
  $('nomatch').hidden = !(total > 0 && list.length === 0);
  $('f-count').textContent = list.length === total ? '' : `Showing ${list.length.toLocaleString()} of ${total.toLocaleString()}`;

  const canConvert = !!(state.status && state.status.tools.ffmpeg);
  const key = [f.kind, f.collection, f.q, canConvert,
    list.map((i) => `${i.id}:${i.mtime}:${i.size}:${i.playable}:${i.duration}:${i.progress ? Math.round(i.progress.position) : ''}`).join(',')].join('|');
  if (key === state.gridKey) return;
  state.gridKey = key;

  grid.replaceChildren();
  appendCards(Math.min(state.shown, list.length));
}

function appendCards(upTo) {
  const grid = $('grid');
  const frag = document.createDocumentFragment();
  for (let i = grid.childElementCount; i < upTo; i++) frag.append(card(state.visible[i]));
  grid.append(frag);
  state.shown = Math.max(state.shown, grid.childElementCount);
}

const moreWatcher = new IntersectionObserver((entries) => {
  if (!entries.some((e) => e.isIntersecting)) return;
  const have = $('grid').childElementCount;
  if (have < state.visible.length) appendCards(Math.min(have + CHUNK, state.visible.length));
}, { rootMargin: '900px 0px' });

function card(item) {
  const img = h('img', { src: item.thumb, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
  img.addEventListener('error', () => img.remove(), { once: true });

  const tag = item.kind === 'video'
    ? h('span', { class: 'thumb-tag' }, h('span', { html: ICON.play }), fmtDuration(item.duration))
    : null;
  const p = item.progress;
  const prog = p && p.duration > 0
    ? h('span', { class: 'thumb-prog', title: 'Partly watched' }, h('i', { style: `width:${Math.min(100, (p.position / p.duration) * 100).toFixed(1)}%` }))
    : null;

  const meta = [fmtBytes(item.size), item.collection].filter(Boolean).join(' · ');

  return h('article', { class: 'item', 'data-id': item.id },
    h('button', { class: 'thumb', type: 'button', 'data-act': 'preview', 'aria-label': `Preview ${item.title}` }, img, tag, prog),
    h('div', { class: 'item-body' },
      h('div', { class: 'item-head' },
        h('div', { class: 'item-title', title: item.file, text: item.title }),
        h('span', { class: 'push' },
          h('button', { class: 'icon-btn', type: 'button', 'data-act': 'reveal', 'aria-label': `Show ${item.title} in Finder`, title: 'Show in Finder', html: ICON.folder }),
          item.writable
            ? h('button', { class: 'icon-btn trash', type: 'button', 'data-act': 'trash', 'aria-label': `Move ${item.title} to Trash`, title: 'Move to Trash', html: ICON.trash })
            : null)),
      h('div', { class: 'item-meta', title: meta, text: meta }),
      cardFoot(item),
      item.playable !== 'yes' && item.note ? h('div', { class: 'item-note', title: item.note, text: item.note }) : null,
    ));
}

function badge(item) {
  if (item.playable === 'no') return h('span', { class: 'badge bad', text: 'Needs converting' });
  if (item.playable === 'maybe') return h('span', { class: 'badge warn', text: 'May not play' });
  return h('span', { class: 'badge ok', text: item.kind === 'photo' ? 'Shows on TV' : 'Plays on TV' });
}

function cardFoot(item) {
  const job = jobFor(item.id);
  const canConvert = item.playable === 'no' && state.status && state.status.tools.ffmpeg;
  return h('div', { class: 'item-foot' },
    job
      ? h('span', { class: 'converting', text: job.state === 'queued' ? 'Waiting to convert' : `Converting ${Math.round(job.percent || 0)}%` })
      : badge(item),
    !job && canConvert ? h('button', { class: 'convert', type: 'button', 'data-act': 'convert', 'aria-label': `Convert ${item.title} for TV`, text: 'Convert' }) : null);
}

function refreshCardFoots() {
  for (const el of $('grid').children) {
    const item = state.items.find((i) => i.id === el.dataset.id);
    const foot = el.querySelector('.item-foot');
    if (item && foot && !foot.contains(document.activeElement)) foot.replaceWith(cardFoot(item));
  }
}

async function onGridClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.item').dataset.id;
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  const act = btn.dataset.act;

  if (act === 'preview') return openViewer(id);

  if (act === 'reveal') {
    try { await api('POST', '/api/folders/reveal', { id }); }
    catch (err) { toast(err.message, true); }
    return;
  }

  if (act === 'convert') {
    btn.disabled = true;
    try {
      await api('POST', `/api/items/${id}/convert`);
      toast(`Making a TV-friendly copy of “${item.title}”. You can keep using HomeFlix meanwhile.`);
      await pollJobs(true);
    } catch (err) {
      btn.disabled = false;
      toast(err.code === 'no_ffmpeg'
        ? 'Converting needs the free tool ffmpeg on this Mac. See the note at the top of your library.'
        : err.message, true);
    }
    return;
  }

  if (act === 'trash') {
    const ok = await confirmDialog({
      title: `Move “${item.title}” to the Trash?`,
      text: 'It will disappear from the TV. You can get it back from the Trash on this Mac until the Trash is emptied.',
      yes: 'Move to Trash',
    });
    if (!ok) return;
    try {
      await api('DELETE', `/api/items/${id}`);
      state.items = state.items.filter((i) => i.id !== id);
      renderGrid();
      toast(`Moved “${item.title}” to the Trash.`);
      refreshLibrarySoon(300);
    } catch (err) {
      toast(err.code === 'read_only'
        ? `“${item.title}” lives in one of your extra folders, which HomeFlix never changes. Delete it in Finder instead.`
        : err.message, true);
    }
  }
}

/* ───────── preview ───────── */

function openViewer(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  state.viewerId = id;
  const dlg = $('viewer');
  const body = $('viewer-body');
  $('viewer-title').textContent = item.title;
  $('viewer-sub').textContent = [
    item.file, fmtBytes(item.size), fmtDuration(item.duration),
    item.width && item.height ? `${item.width} × ${item.height}` : '', item.collection,
  ].filter(Boolean).join(' · ');

  stopViewerMedia();
  const cannot = () => body.replaceChildren(h('div', { class: 'viewer-msg' },
    h('strong', { text: 'This one can’t be previewed here' }),
    item.kind === 'photo'
      ? 'This photo couldn’t be opened. The file may be damaged.'
      : item.playable === 'yes'
        ? 'This browser couldn’t open the video. It may still play on the TV. If it doesn’t, the file may be damaged.'
        : item.note || 'This browser can’t play this kind of video, and most TVs can’t either. Converting it to MP4 fixes that.'));

  if (item.kind === 'video') {
    const video = h('video', { controls: true, preload: 'metadata', playsinline: true, poster: item.thumb });
    video.addEventListener('error', cannot, { once: true });
    video.src = item.src;
    body.replaceChildren(video);
  } else {
    const img = h('img', { alt: item.title });
    img.addEventListener('error', cannot, { once: true });
    img.src = `/photo/${item.id}?w=1920`;
    body.replaceChildren(img);
  }

  const idx = state.visible.findIndex((i) => i.id === id);
  $('viewer-prev').disabled = idx <= 0;
  $('viewer-next').disabled = idx < 0 || idx >= state.visible.length - 1;
  if (!dlg.open) dlg.showModal();
}

function stepViewer(delta) {
  const idx = state.visible.findIndex((i) => i.id === state.viewerId);
  const next = state.visible[idx + delta];
  if (idx >= 0 && next) openViewer(next.id);
}

function stopViewerMedia() {
  const video = $('viewer-body').querySelector('video');
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
}

function closeViewer() {
  const dlg = $('viewer');
  if (dlg.open) dlg.close();
}

/* ───────── conversion jobs ───────── */

let jobsTimer = 0;
async function pollJobs(now) {
  clearTimeout(jobsTimer);
  if (!now && !state.online) { jobsTimer = setTimeout(pollJobs, 8000); return; }
  let active = false;
  try {
    const { jobs } = await api('GET', '/api/jobs');
    let finished = false;
    for (const j of jobs) {
      const before = state.jobStates.get(j.id);
      if (before && before !== j.state) {
        if (j.state === 'done') { finished = true; toast(`“${j.title}” is converted. The new copy plays on TV.`); }
        if (j.state === 'failed') toast(`“${j.title}” couldn’t be converted.`, true);
      }
      state.jobStates.set(j.id, j.state);
    }
    state.jobs = jobs;
    active = jobs.some((j) => j.state === 'queued' || j.state === 'running');
    renderJobs();
    refreshCardFoots();
    if (finished) refreshLibrarySoon(200);
  } catch { /* status poll handles a lost server */ }
  jobsTimer = setTimeout(pollJobs, active ? 1500 : 8000);
}

function renderJobs() {
  const rows = state.jobs.filter((j) => !state.hiddenJobs.has(j.id) && j.state !== 'done');
  $('jobs').hidden = rows.length === 0;
  const list = $('job-rows');
  const focusedId = document.activeElement && document.activeElement.closest ? (document.activeElement.closest('#job-rows .row') || {}).dataset?.id : null;
  list.replaceChildren(...rows.map((j) => {
    const failed = j.state === 'failed';
    const info = failed
      ? `${j.error || 'The conversion stopped unexpectedly.'} The original file is untouched.`
      : j.state === 'queued' ? 'Waiting its turn' : `${Math.round(j.percent || 0)}% done`;
    return h('li', { class: 'row', 'data-id': j.id, 'data-state': failed ? 'failed' : j.state },
      h('div', { class: 'row-name', text: j.title }),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn small quiet', type: 'button', 'data-job': failed ? 'hide' : 'cancel', text: failed ? 'Dismiss' : 'Cancel' })),
      h('div', { class: 'row-info', text: info }),
      failed ? null : h('div', { class: 'bar' }, h('i', { style: `transform:scaleX(${Math.min(1, (j.percent || 0) / 100)})` })),
    );
  }));
  if (focusedId) list.querySelector(`[data-id="${CSS.escape(focusedId)}"] button`)?.focus();
}

async function onJobClick(e) {
  const btn = e.target.closest('[data-job]');
  if (!btn) return;
  const id = btn.closest('.row').dataset.id;
  const dismiss = btn.dataset.job === 'hide';
  btn.disabled = true;
  try {
    await api('DELETE', `/api/jobs/${id}`);
    state.hiddenJobs.add(id);
    if (!dismiss) toast('Conversion cancelled.');
  } catch (err) {
    // A failed job that the server has already forgotten is as good as dismissed.
    if (dismiss && err.status === 404) state.hiddenJobs.add(id);
    else toast(err.message, true);
  }
  pollJobs(true);
}

/* ───────── uploads ───────── */

function collectionValue() {
  return $('collection').value.replace(/[\\/:]/g, ' ').replace(/\s+/g, ' ').trim();
}

function addFiles(entries) {
  // entries: [{ file, collection? , nested? }]
  const typed = collectionValue();
  const rejected = [];
  let skippedNested = 0;
  let added = 0;
  for (const { file, collection, nested } of entries) {
    const ext = extOf(file.name);
    if (!ALLOWED.has(ext)) {
      if (nested) skippedNested++; else rejected.push(file.name);
      continue;
    }
    added++;
    queueUpload({
      file, name: file.name, total: file.size, collection: typed || collection || '',
      state: 'queued', loaded: 0, info: 'Waiting',
    });
  }

  if (rejected.length && rejected.length <= 4) {
    for (const name of rejected) {
      const ext = extOf(name);
      queueUpload({
        name, state: 'rejected', total: 0, loaded: 0,
        info: `Not added. HomeFlix takes videos and photos, and ${ext ? `.${ext} files aren’t` : 'this isn’t'} a kind it can use.`,
      });
    }
  } else if (rejected.length) {
    queueUpload({
      name: `${rejected.length} files were not added`, state: 'rejected', total: 0, loaded: 0,
      info: `HomeFlix takes videos and photos only. Left out: ${rejected.slice(0, 5).join(', ')} and ${rejected.length - 5} more.`,
    });
  }
  if (skippedNested) {
    queueUpload({
      name: `${plural(skippedNested, 'other file', 'other files')} in the folder left out`, state: 'rejected', total: 0, loaded: 0,
      info: 'Only the videos and photos were taken.',
    });
  }
  if (!added && !rejected.length && !skippedNested) toast('There were no files in that drop.', true);
  $('uploads').hidden = false;
  if (added || rejected.length) $('uploads').scrollIntoView({ block: 'nearest' });
  pumpUploads();
  renderUploadSummary();
}

function queueUpload(u) {
  u.id = ++state.uploadSeq;
  u.samples = [];
  state.uploads.push(u);

  u.infoEl = h('div', { class: 'row-info', text: u.info });
  u.barEl = h('i');
  u.actEl = h('div', { class: 'row-actions' });
  u.el = h('li', { class: 'row', 'data-id': u.id, 'data-state': u.state },
    h('div', { class: 'row-name', title: u.name, text: u.collection ? `${u.name}  →  ${u.collection}` : u.name }),
    u.actEl, u.infoEl,
    h('div', { class: 'bar' }, u.barEl));
  $('up-rows').append(u.el);
  paintUpload(u);
}

function paintUpload(u) {
  u.el.dataset.state = u.state;
  u.infoEl.textContent = u.info;
  u.barEl.style.transform = `scaleX(${u.total ? Math.min(1, u.loaded / u.total) : 0})`;
  const want = u.state === 'queued' || u.state === 'uploading' ? 'cancel'
    : (u.state === 'failed' && u.retry) || u.state === 'cancelled' ? 'retry' : '';
  if (u.actEl.dataset.kind !== want) {
    const hadFocus = u.actEl.contains(document.activeElement);
    u.actEl.dataset.kind = want;
    u.actEl.replaceChildren(want
      ? h('button', { class: 'btn small quiet', type: 'button', 'data-up': want, 'aria-label': `${want === 'cancel' ? 'Cancel' : 'Try again'}: ${u.name}`, text: want === 'cancel' ? 'Cancel' : 'Try again' })
      : '');
    if (hadFocus) u.actEl.querySelector('button')?.focus();
  }
}

function pumpUploads() {
  let active = state.uploads.filter((u) => u.state === 'uploading').length;
  for (const u of state.uploads) {
    if (active >= MAX_UPLOADS) break;
    if (u.state !== 'queued') continue;
    startUpload(u);
    active++;
  }
}

function startUpload(u) {
  const xhr = new XMLHttpRequest();
  u.xhr = xhr;
  u.state = 'uploading';
  u.loaded = 0;
  u.samples = [{ t: performance.now(), n: 0 }];
  u.info = `Starting… ${fmtBytes(u.total)}`;
  paintUpload(u);

  const qs = new URLSearchParams({ name: u.name });
  if (u.collection) qs.set('collection', u.collection);
  xhr.open('POST', `/api/upload?${qs}`);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');

  xhr.upload.onprogress = (e) => {
    if (u.state !== 'uploading') return;
    const now = performance.now();
    u.loaded = e.loaded;
    if (e.lengthComputable) u.total = e.total;
    u.samples.push({ t: now, n: e.loaded });
    while (u.samples.length > 2 && now - u.samples[0].t > 4000) u.samples.shift();
    const first = u.samples[0];
    const secs = (now - first.t) / 1000;
    const speed = secs > 0.25 ? (e.loaded - first.n) / secs : 0;
    const parts = [`${fmtBytes(u.loaded)} of ${fmtBytes(u.total)}`];
    if (u.loaded >= u.total) parts.push('finishing up…');
    else if (speed > 0) parts.push(`${fmtBytes(speed)} a second`, fmtRemaining((u.total - u.loaded) / speed));
    u.info = parts.join(' · ');
    paintUpload(u);
    renderUploadSummary();
  };

  xhr.onload = () => {
    let data = null;
    try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
    if (xhr.status >= 200 && xhr.status < 300) {
      u.state = 'done';
      u.loaded = u.total;
      const saved = data && data.item;
      u.info = saved && saved.file !== u.name ? `Added as “${saved.file}”, because that name was taken` : 'Added';
      refreshLibrarySoon(400);
    } else {
      const code = data && data.code;
      u.state = 'failed';
      u.retry = true;
      if (xhr.status === 415 || code === 'unsupported_type') {
        u.retry = false;
        u.info = `Not added. “${u.name}” isn’t a kind of video or photo HomeFlix can use.`;
      } else if (xhr.status === 507 || code === 'disk_full') {
        u.info = 'This Mac’s disk is full. Free up some space (empty the Trash, delete things you don’t need), then try again.';
      } else if (code === 'bad_name') {
        u.retry = false;
        u.info = 'HomeFlix can’t save a file with this name. Rename it in Finder (plain letters and numbers), then add it again.';
      } else {
        u.info = `${(data && data.error) || 'This file didn’t go through.'} Try again.`;
      }
    }
    finishUpload(u);
  };
  xhr.onerror = () => {
    u.state = 'failed';
    u.retry = true;
    u.info = 'The connection to HomeFlix dropped partway. Check HomeFlix is still open, then try again.';
    finishUpload(u);
  };
  xhr.onabort = () => {
    u.state = 'cancelled';
    u.info = 'Cancelled';
    finishUpload(u);
  };
  xhr.send(u.file);
}

function finishUpload(u) {
  u.xhr = null;
  paintUpload(u);
  pumpUploads();
  renderUploadSummary();
  renderJourney();
}

let tidyTimer = 0;
function renderUploadSummary() {
  const real = state.uploads.filter((u) => u.file);
  const live = real.filter((u) => u.state === 'queued' || u.state === 'uploading');
  const done = real.filter((u) => u.state === 'done').length;
  const failed = state.uploads.filter((u) => u.state === 'failed' || u.state === 'rejected').length;
  const counted = real.filter((u) => u.state !== 'cancelled' && u.state !== 'failed');
  const total = counted.reduce((n, u) => n + u.total, 0);
  const loaded = counted.reduce((n, u) => n + (u.state === 'done' ? u.total : u.loaded), 0);

  $('uploads').hidden = state.uploads.length === 0;
  $('up-title').textContent = live.length
    ? `Adding ${plural(live.length, 'file', 'files')}${done ? `, ${done} done` : ''}`
    : failed ? `${done} added, ${failed} not added` : done ? `${plural(done, 'file', 'files')} added` : 'Nothing was added';
  $('up-total').style.transform = `scaleX(${total ? loaded / total : live.length ? 0 : 1})`;
  $('up-cancel-all').hidden = live.length === 0;
  $('up-clear').hidden = state.uploads.length === live.length;

  clearTimeout(tidyTimer);
  if (!live.length && state.uploads.length && state.uploads.every((u) => u.state === 'done')) {
    tidyTimer = setTimeout(clearFinishedUploads, 8000);
  }
}

function clearFinishedUploads() {
  state.uploads = state.uploads.filter((u) => {
    const keep = u.state === 'queued' || u.state === 'uploading';
    if (!keep) u.el.remove();
    return keep;
  });
  renderUploadSummary();
}

function onUploadClick(e) {
  const btn = e.target.closest('[data-up]');
  if (!btn) return;
  const id = Number(btn.closest('.row').dataset.id);
  const u = state.uploads.find((x) => x.id === id);
  if (!u) return;
  if (btn.dataset.up === 'cancel') cancelUpload(u);
  else {
    u.state = 'queued';
    u.loaded = 0;
    u.info = 'Waiting';
    paintUpload(u);
    pumpUploads();
    renderUploadSummary();
  }
}

function cancelUpload(u) {
  if (u.state === 'uploading' && u.xhr) u.xhr.abort();
  else if (u.state === 'queued') {
    u.state = 'cancelled';
    u.info = 'Cancelled';
    paintUpload(u);
    renderUploadSummary();
  }
}

function uploadsActive() {
  return state.uploads.some((u) => u.state === 'queued' || u.state === 'uploading');
}

function chooseFiles() {
  const input = $('file-input');
  input.value = '';
  input.click();
}

/* Folders dropped from Finder: every file inside goes to an album named after the folder. */
async function entriesFromDrop(dt) {
  const roots = [];
  for (const it of dt.items || []) {
    if (it.kind !== 'file') continue;
    const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    roots.push({ entry, file: entry && entry.isFile ? it.getAsFile() : null });
  }
  if (!roots.length || roots.some((r) => !r.entry)) return [...dt.files].map((file) => ({ file }));

  const out = [];
  const walk = async (entry, top) => {
    if (entry.name.startsWith('.')) return;
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, collection: top, nested: true });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, top);
      }
    }
  };
  for (const r of roots) {
    if (r.file) out.push({ file: r.file });
    else {
      try { await walk(r.entry, r.entry.name); }
      catch { toast(`HomeFlix couldn’t read everything inside “${r.entry.name}”. Try dropping the files themselves.`, true); }
    }
  }
  return out;
}

function wireDrop() {
  const veil = $('veil');
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  const hide = () => { depth = 0; veil.hidden = true; };

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    if (state.online) {
      const c = collectionValue();
      $('veil-sub').textContent = c ? `They will go into “${c}”` : 'Videos and photos, or whole folders';
      veil.hidden = false;
    }
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = state.online ? 'copy' : 'none';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    if (!state.online) return;
    addFiles(await entriesFromDrop(e.dataTransfer));
  });
}

/* ───────── folders ───────── */

function pathEl(p) {
  const cut = p.replace(/\/+$/, '').lastIndexOf('/');
  return cut < 0 ? [p] : [p.slice(0, cut + 1), h('b', { text: p.slice(cut + 1) })];
}

let foldersKey = '';
function renderFolders() {
  const cfg = state.status.config;
  const key = JSON.stringify([cfg.libraryFolder, cfg.extraFolders, state.picking]);
  if (key === foldersKey) return;
  foldersKey = key;

  $('lib-path').replaceChildren(...pathEl(cfg.libraryFolder));
  const list = $('extra-list');
  list.replaceChildren(...(cfg.extraFolders.length
    ? cfg.extraFolders.map((p) => h('li', null,
      h('span', { class: 'path' }, ...pathEl(p)),
      h('div', { class: 'folder-actions' },
        h('button', { class: 'btn small', type: 'button', 'data-reveal': p, text: 'Show in Finder' }),
        h('button', { class: 'btn small quiet', type: 'button', 'data-remove': p, 'aria-label': `Remove ${p} from HomeFlix`, text: 'Remove' }))))
    : [h('li', { class: 'none', text: 'No extra folders. Add one if you keep videos or photos somewhere else.' })]));

  $('picking').hidden = !state.picking;
  for (const id of ['lib-change', 'extra-add']) $(id).disabled = state.picking;
}

async function pickFolder() {
  if (state.picking) return null;
  state.picking = true;
  renderFolders();
  try {
    const res = await api('POST', '/api/folders/choose');
    return res && res.path ? res.path : null;
  } catch (err) {
    toast(err.message, true);
    return null;
  } finally {
    state.picking = false;
    if (state.status) renderFolders();
  }
}

async function saveConfig(patch, okMessage) {
  try {
    const s = await api('PUT', '/api/config', patch);
    applyStatus(s);
    if (okMessage) toast(okMessage);
    return s;
  } catch (err) {
    toast(err.message, true);
    return null;
  }
}

async function changeLibraryFolder() {
  const path = await pickFolder();
  if (!path) return;
  const cfg = state.status.config;
  if (path === cfg.libraryFolder) return;
  const extraFolders = cfg.extraFolders.filter((p) => p !== path);
  await saveConfig(
    extraFolders.length !== cfg.extraFolders.length ? { libraryFolder: path, extraFolders } : { libraryFolder: path },
    'Library folder changed. New files will be saved there. Nothing was moved or deleted.');
}

async function addExtraFolder() {
  const path = await pickFolder();
  if (!path) return;
  const cfg = state.status.config;
  if (path === cfg.libraryFolder) return toast('That is already your library folder.', true);
  if (cfg.extraFolders.includes(path)) return toast('That folder is already in the list.', true);
  await saveConfig({ extraFolders: [...cfg.extraFolders, path] }, 'Folder added. Its videos and photos will appear in a moment.');
}

async function onFoldersClick(e) {
  const reveal = e.target.closest('[data-reveal]');
  const remove = e.target.closest('[data-remove]');
  if (reveal) {
    try { await api('POST', '/api/folders/reveal', { path: reveal.dataset.reveal }); }
    catch (err) { toast(err.message, true); }
  } else if (remove) {
    const cfg = state.status.config;
    await saveConfig(
      { extraFolders: cfg.extraFolders.filter((p) => p !== remove.dataset.remove) },
      'Removed from HomeFlix. The folder and everything in it are untouched.');
  }
}

/* ───────── settings ───────── */

let settingsSeen = null;   // config values the form was last filled from
let settingsBusy = false;

function settingsDirty() {
  if (!settingsSeen) return false;
  return $('s-name').value !== settingsSeen.name || $('s-port').value.trim() !== String(settingsSeen.port);
}

function renderSettings() {
  const s = state.status;
  const cfg = s.config;
  if (!settingsDirty() && !settingsBusy) {
    settingsSeen = { name: cfg.name, port: cfg.port };
    if (document.activeElement !== $('s-name')) $('s-name').value = cfg.name;
    if (document.activeElement !== $('s-port')) $('s-port').value = cfg.port;
  }
  if (!autoBusy) $('s-auto').checked = !!cfg.autoStart;
  $('version').textContent = `${s.name} ${s.version}`;
  paintSettingsForm();
}

function portProblem() {
  const raw = $('s-port').value.trim();
  if (!/^\d+$/.test(raw)) return 'Use digits only, for example 8080.';
  const n = Number(raw);
  if (n < 1024 || n > 65535) return 'Choose a number from 1024 to 65535.';
  return '';
}

function paintSettingsForm() {
  const dirty = settingsDirty();
  const problem = dirty ? portProblem() : '';
  const err = $('s-port-err');
  err.hidden = !problem;
  err.textContent = problem;
  $('s-port').setAttribute('aria-invalid', String(!!problem));
  $('s-save').disabled = !dirty || !!problem || settingsBusy;
  $('s-reset').hidden = !dirty;
  if (dirty) {
    const portChanged = !problem && settingsSeen && Number($('s-port').value) !== settingsSeen.port;
    $('s-note').textContent = portChanged && state.status.running
      ? 'Saving will change the TV address. You’ll need to type the new one on the TV.'
      : '';
  }
}

async function saveSettings(e) {
  e.preventDefault();
  if (portProblem()) { paintSettingsForm(); $('s-port').focus(); return; }
  const name = $('s-name').value.trim() || 'HomeFlix';
  const port = Number($('s-port').value.trim());
  const portChanged = port !== settingsSeen.port;
  const wasRunning = state.status.running;
  settingsBusy = true;
  paintSettingsForm();
  try {
    const s = await api('PUT', '/api/config', { name, port });
    settingsSeen = { name: s.config.name, port: s.config.port };
    $('s-name').value = s.config.name;
    $('s-port').value = s.config.port;
    settingsBusy = false;
    applyStatus(s);
    $('s-note').textContent = portChanged && wasRunning ? 'Saved. The TV address has changed: see the top of this page.' : 'Saved.';
    setTimeout(() => { if (!settingsDirty()) $('s-note').textContent = ''; }, 6000);
  } catch (err) {
    settingsBusy = false;
    paintSettingsForm();
    $('s-note').textContent = '';
    toast(err.message, true);
  }
}

function resetSettings() {
  $('s-name').value = settingsSeen.name;
  $('s-port').value = settingsSeen.port;
  $('s-note').textContent = '';
  paintSettingsForm();
}

let autoBusy = false;
async function saveAutoStart() {
  const box = $('s-auto');
  autoBusy = true;
  const s = await saveConfig({ autoStart: box.checked });
  autoBusy = false;
  if (!s) box.checked = !box.checked;
}

/* ───────── help ───────── */

let helpKey = '';
function renderHelp() {
  const s = state.status;
  const urls = s.running ? [s.url, ...(s.altUrls || [])].filter(Boolean) : [];
  const key = JSON.stringify([urls, s.wifiName]);
  if (key === helpKey) return;
  helpKey = key;
  $('trouble-wifi').replaceChildren(...(s.wifiName ? [' (this Mac is on ', h('strong', { text: s.wifiName }), ')'] : []));
  const alt = $('trouble-alt');
  if (urls.length > 1) {
    alt.replaceChildren('Any of these leads to the same place: ', ...urls.map((u) => h('span', { class: 'alt-url', text: u })));
  } else if (urls.length === 1) {
    alt.replaceChildren('HomeFlix only found one address for this Mac: ', h('span', { class: 'alt-url', text: urls[0] }));
  } else {
    alt.replaceChildren('When HomeFlix is on, other addresses to try are listed here.');
  }
}

/* ───────── wiring ───────── */

function wire() {
  $('switch').addEventListener('click', togglePower);
  $('stage-on').addEventListener('click', () => setPower(true));
  $('j2-btn').addEventListener('click', () => setPower(true));
  $('stage-problem-fix').addEventListener('click', () => {
    $('settings').scrollIntoView();
    $('s-port').focus();
    $('s-port').select();
  });
  $('copy').addEventListener('click', () => copyText(state.status.url, 'Address copied.'));

  for (const id of ['add-btn', 'empty-btn', 'j1-btn']) $(id).addEventListener('click', chooseFiles);
  $('file-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    if (files.length) addFiles(files.map((file) => ({ file })));
  });
  $('up-rows').addEventListener('click', onUploadClick);
  $('up-clear').addEventListener('click', clearFinishedUploads);
  $('up-cancel-all').addEventListener('click', () => {
    for (const u of [...state.uploads].reverse()) cancelUpload(u);
  });
  window.addEventListener('beforeunload', (e) => {
    if (!uploadsActive()) return;
    e.preventDefault();
    e.returnValue = '';
  });
  wireDrop();
  window.addEventListener('resize', fitAddress);

  $('ffmpeg-copy').addEventListener('click', () => copyText('brew install ffmpeg', 'Command copied. Paste it into Terminal and press Return.'));
  $('ffmpeg-dismiss').addEventListener('click', () => {
    store('homeflix.ffmpegHint', 'hidden');
    $('ffmpeg-hint').hidden = true;
  });

  $('job-rows').addEventListener('click', onJobClick);
  $('grid').addEventListener('click', onGridClick);
  moreWatcher.observe($('grid-more'));

  for (const btn of document.querySelectorAll('.seg button')) {
    btn.addEventListener('click', () => {
      state.filter.kind = btn.dataset.kind;
      for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b === btn));
      renderGrid(true);
    });
  }
  $('f-collection').addEventListener('change', (e) => { state.filter.collection = e.target.value; renderGrid(true); });
  let searchTimer = 0;
  $('f-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filter.q = e.target.value; renderGrid(true); }, 120);
  });
  $('f-reset').addEventListener('click', () => {
    state.filter = { kind: 'all', collection: '', q: '' };
    $('f-search').value = '';
    $('f-collection').value = '';
    for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.kind === 'all'));
    renderGrid(true);
  });

  const viewer = $('viewer');
  $('viewer-close').addEventListener('click', closeViewer);
  $('viewer-prev').addEventListener('click', () => stepViewer(-1));
  $('viewer-next').addEventListener('click', () => stepViewer(1));
  viewer.addEventListener('close', () => {
    stopViewerMedia();
    $('viewer-body').replaceChildren();
    const back = state.viewerId && $('grid').querySelector(`[data-id="${CSS.escape(state.viewerId)}"] .thumb`);
    state.viewerId = null;
    if (back) back.focus();
  });
  viewer.addEventListener('click', (e) => { if (e.target === viewer) closeViewer(); });
  viewer.addEventListener('keydown', (e) => {
    if (e.target.closest('video')) return; // arrow keys scrub the video
    if (e.key === 'ArrowLeft') stepViewer(-1);
    if (e.key === 'ArrowRight') stepViewer(1);
  });

  $('lib-reveal').addEventListener('click', async () => {
    try { await api('POST', '/api/folders/reveal', { path: state.status.config.libraryFolder }); }
    catch (err) { toast(err.message, true); }
  });
  $('lib-change').addEventListener('click', changeLibraryFolder);
  $('extra-add').addEventListener('click', addExtraFolder);
  $('extra-list').addEventListener('click', onFoldersClick);
  $('rescan').addEventListener('click', async () => {
    try { applyStatus(await api('POST', '/api/rescan')); toast('Checking your folders for new files.'); }
    catch (err) { toast(err.message, true); }
  });

  $('settings-form').addEventListener('submit', saveSettings);
  $('s-name').addEventListener('input', paintSettingsForm);
  $('s-port').addEventListener('input', paintSettingsForm);
  $('s-reset').addEventListener('click', resetSettings);
  $('s-auto').addEventListener('change', saveAutoStart);
}

wire();
pollStatus();
pollJobs(true);
