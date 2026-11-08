'use strict';

// ---------------------------------------------------------------- state
const store = {
  get(k, d) { try { const v = localStorage.getItem('t7sviewer.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('t7sviewer.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};
const read = new Set(store.get('read', []));
const bookmarks = store.get('bookmarks', {});
// textRate / autoRate: 0-100 sliders whose 50 is the game's default (see textDelayFor / autoScaleFor in player.js)
const settings = Object.assign({ textRate: 50, autoRate: AUTO_DEFAULT, voice: 100, bgm: 45, se: 70, playerName: 'あなた' }, store.get('settings', {}));

let player;
const T = { layers: new Map(), kids: new Map(), scns: new Map(), roots: [], byId: new Map() };
const menu = { path: store.get('path', []), unreadOnly: store.get('unreadOnly', false), topCat: store.get('topCat', '0') };
let current = null;     // scenario being played
let voiceOff = false;
// deep-link override (&ts=1 shows text instantly; used for screenshots)
const testTextSpeed = new URLSearchParams(location.hash.slice(1)).get('ts') != null
  ? Number(new URLSearchParams(location.hash.slice(1)).get('ts')) : null;

const key = (cat, id) => cat + ':' + id;
// header labels the game uses for each episode category (from its string table)
const CATEGORY_TITLES = { 0: 'メインエピソード', 1: 'サブエピソード', 2: 'イベントエピソード' };
const byId = (a, b) => String(a.scenario_id || a.layer_id).localeCompare(String(b.scenario_id || b.layer_id), undefined, { numeric: true });
// the game lists layers by descending priority (ties by id) and stories by ascending priority
const layerOrder = (a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || byId(a, b);
const byPriority = (a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0) || byId(a, b);

// ---------------------------------------------------------------- boot
async function init() {
  fitScreen();
  window.addEventListener('resize', fitScreen);
  const [tree, facepos] = await Promise.all([fetch('/api/tree').then((r) => r.json()), fetch('/api/facepos').then((r) => r.json())]);
  indexTree(tree);
  player = new Player(facepos);
  player.onChange = onPlayerChange;
  player.onEnd = onEpisodeEnd;
  player.onBackAtStart = backToPreviousEpisode;
  bindUiSound();
  applySettings();
  bindMenu();
  bindAdv();
  bindKeys();
  // drop a stale saved path (e.g. after the data changed)
  menu.path = menu.path.filter((k) => T.layers.has(k));
  await document.fonts.ready;
  // deep links: #m=<cat:layer>,<cat:layer>  opens a menu level; #s=<scenario id>&p=<page> opens a story
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('m') != null) menu.path = h.get('m').split(',').filter((k) => T.layers.has(k));
  renderMenu();
  const sid = h.get('s');
  if (sid && T.byId.has(sid)) {
    await playScenario(T.byId.get(sid), { voice: h.get('voice') !== '0', startPage: Number(h.get('p')) || 0 });
    if (h.get('tb') === '1') openToolbar(true);
  }
  // fixed set of dialogs that can be opened from the URL (handy for screenshots)
  const pop = h.get('pop');
  if (pop === 'settings') showSettings();
  else if (pop === 'help') showHelp();
  else if (pop === 'log') showLog();
  else if (pop === 'play' && h.get('id') && T.byId.has(h.get('id'))) confirmPlay(T.byId.get(h.get('id')));
  else if (pop === 'info' && h.get('id') && T.byId.has(h.get('id'))) showInfo(T.byId.get(h.get('id')));
  else if (pop === 'sound') openSound();
  // the sound player's lists load in the background, so its first opening doesn't wait for them
  (window.requestIdleCallback || setTimeout)(() => loadSoundData());
}

function indexTree(tree) {
  for (const l of tree.layers) {
    const k = key(l.category, l.layer_id);
    T.layers.set(k, { ...l, key: k, parentKey: key(l.category, l.parent_id) });
  }
  for (const l of T.layers.values()) {
    if (T.layers.has(l.parentKey)) push(T.kids, l.parentKey, l); else T.roots.push(l);
  }
  for (const s of tree.scenarios) {
    s.key = key(s.category, s.parent_layer_id);
    push(T.scns, s.key, s);
    T.byId.set(s.scenario_id, s);
  }
  for (const v of T.kids.values()) v.sort(layerOrder);
  for (const v of T.scns.values()) v.sort(byPriority);
  // top screen: main story first, then sub, then events
  T.roots.sort((a, b) => Number(a.category === '2') - Number(b.category === '2') || Number(a.category) - Number(b.category) || layerOrder(a, b));
  T.chars = tree.characters || {};
  T.total = tree.scenarios.length;
  T.available = tree.scenarios.filter((s) => s.available).length;
}
function push(map, k, v) { if (!map.has(k)) map.set(k, []); map.get(k).push(v); }

function fitScreen() {
  const s = document.getElementById('screen');
  const k = Math.min(window.innerWidth / 1136, window.innerHeight / 640);
  s.style.transform = `translate(-50%, -50%) scale(${k})`;
}

// ---------------------------------------------------------------- menu
const unreadMemo = new Map();
function unreadIn(layerKey) {
  if (unreadMemo.has(layerKey)) return unreadMemo.get(layerKey);
  let n = (T.scns.get(layerKey) || []).filter((s) => s.available && !read.has(s.scenario_id)).length;
  for (const k of T.kids.get(layerKey) || []) n += unreadIn(k.key);
  unreadMemo.set(layerKey, n);
  return n;
}

function renderMenu() {
  unreadMemo.clear();
  const m = document.getElementById('menu');
  const list = document.getElementById('mList');
  const atTop = menu.path.length === 0;
  m.classList.toggle('at-top', atTop);
  document.getElementById('mUnread').setAttribute('aria-pressed', String(menu.unreadOnly));
  document.getElementById('mCount').textContent = `収録 ${T.available}/${T.total}`;
  store.set('path', menu.path);

  const chain = menu.path.map((k) => T.layers.get(k));
  document.getElementById('mTitle').textContent = atTop ? 'エピソード' : (CATEGORY_TITLES[chain[0].category] || 'エピソード');
  const crumb = chain.slice(1).map((l) => [l.title, l.subtitle].filter(Boolean).join(' ')).join(' > ');
  const crumbEl = document.getElementById('mCrumb');
  crumbEl.firstElementChild.textContent = crumb;
  crumbEl.classList.toggle('empty', !crumb);

  // background and side character come from the nearest layer that defines them
  const roots = T.roots;
  // layered so the nearest background that exists shows; missing files simply don't paint
  const bgCands = [...new Set([...chain].reverse().map((l) => l.bg_img_path).concat(roots.map((l) => l.bg_img_path)).filter(Boolean))];
  document.querySelector('.m-bg').style.backgroundImage = bgCands.map((n) => `url("${asset(n)}")`).join(', ') || 'none';
  // like the game, only the layer that defines a side character shows it (not its sub-layers)
  const chara = chain.length ? chain[chain.length - 1].character_img_path : null;
  const ci = document.querySelector('.m-chara');
  if (chara) ci.src = asset(chara); else ci.removeAttribute('src');

  if (atTop) return renderTop();

  const here = chain[chain.length - 1];
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const l of T.kids.get(here.key) || []) {
    const unread = unreadIn(l.key);
    if (menu.unreadOnly && !unread) continue;
    if (!hasContent(l.key)) continue;
    frag.appendChild(layerItem(l, unread));
  }
  for (const s of T.scns.get(here.key) || []) {
    if (menu.unreadOnly && (read.has(s.scenario_id) || !s.available)) continue;
    frag.appendChild(scenarioItem(s));
  }
  if (!frag.childNodes.length) {
    const e = document.createElement('div');
    e.className = 'm-empty';
    e.textContent = menu.unreadOnly ? '未読のエピソードはありません' : 'エピソードがありません';
    frag.appendChild(e);
  }
  list.appendChild(frag);
  list.scrollTop = store.get('scroll:' + here.key, 0);
  list.onscroll = () => store.set('scroll:' + here.key, list.scrollTop);
}

function hasContent(layerKey) {
  if ((T.scns.get(layerKey) || []).length) return true;
  return (T.kids.get(layerKey) || []).some((k) => hasContent(k.key));
}

// top エピソード screen: category tabs (left), the chosen category's series (centre),
// a recommended next story under each main series
function renderTop() {
  const top = document.getElementById('mTop');
  top.innerHTML = '';
  const cat = menu.topCat || '0';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const side = el('div', 't-side');
  for (const c of ['0', '1', '2']) {
    const all = [...T.byId.values()].filter((s) => s.category === c);
    if (!all.length) continue;
    const done = all.filter((s) => read.has(s.scenario_id)).length;
    const b = el('button', 't-cat' + (c === cat ? ' on' : ''));
    const shape = el('span', 't-cat-shape');
    shape.appendChild(el('span', 't-cat-fill'));
    b.append(shape, el('span', 't-cat-name', CATEGORY_TITLES[c]), el('span', 't-cat-arrow'));
    const pill = el('span', 't-cat-count');
    pill.append(el('span', 'lbl', '読破済'), el('b', '', String(done)), el('span', 'sep', '/'), el('b', '', String(all.length)));
    b.append(pill);
    if (all.some((s) => s.available && !read.has(s.scenario_id))) b.appendChild(newBadge());
    b.addEventListener('click', () => { menu.topCat = c; store.set('topCat', c); renderTop(); });
    side.appendChild(b);
  }
  const row1 = el('div', 't-btns');
  const search = el('button', 't-btn blue', 'キャラ検索');
  search.prepend(svgIcon('search'));
  search.onclick = showSearch;
  const resume = el('button', 't-btn orange', '中断エピソード');
  resume.onclick = showSuspended;
  row1.append(search, resume);
  const row2 = el('div', 't-btns');
  const set = el('button', 't-btn white', '設定');
  set.onclick = showSettings;
  // サウンドプレイヤー sits where the game has 一括DL
  const sound = el('button', 't-btn white sound', 'サウンド');
  sound.prepend(svgIcon('note'));
  sound.onclick = openSound;
  row2.append(set, sound);
  side.append(row1, row2);
  top.appendChild(side);

  const centre = el('div', 't-centre t-cat' + cat);
  const roots = T.roots.filter((l) => l.category === cat && hasContent(l.key));
  for (const l of roots) {
    const col = el('div', 't-col');
    const b = el('button', 't-series');
    const im = new Image();
    im.alt = l.title || '';
    // main series use the shorter banner variant so the recommendation fits underneath
    const art = cat === '0' ? l.btn_img_path.replace('.png', '_short.png') : l.btn_img_path;
    im.onerror = () => { if (im.src.indexOf('_short') > 0) im.src = asset(l.btn_img_path); };
    im.src = asset(art);
    b.appendChild(im);
    if (unreadIn(l.key)) b.appendChild(newBadge());
    b.addEventListener('click', () => enter(l));
    b.addEventListener('contextmenu', (e) => showReadMenu(e, seriesOrder(l.key)));
    col.appendChild(b);
    if (cat === '0') { const rec = recommendCard(l); if (rec) col.appendChild(rec); }
    centre.appendChild(col);
  }
  top.appendChild(centre);
}

// first unread story of the series (falls back to the first story)
function recommendFor(root) {
  const order = seriesOrder(root.key).filter((s) => s.available);
  return order.find((s) => !read.has(s.scenario_id)) || order[0] || null;
}

function recommendCard(root) {
  const s = recommendFor(root);
  if (!s) return null;
  const card = document.createElement('div');
  card.className = 't-rec';
  card.style.backgroundImage = `url("${asset(root.btn_img_path.replace('.png', '_recommend.png'))}")`;
  const layer = T.layers.get(s.key);
  const th = new Image();
  th.className = 'thumb';
  th.alt = '';
  if (s.img_path) th.src = asset(s.img_path);
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = (layer && (layer.subtitle || layer.title)) || s.subtitle || '';
  const name = document.createElement('div');
  name.className = 'name';
  // the game shows the story's title, then its episode number (第n話 …)
  for (const line of [s.title, s.subtitle].filter(Boolean)) {
    const d = document.createElement('div');
    d.className = 'line';
    d.textContent = line;
    name.appendChild(d);
  }
  const go = document.createElement('button');
  go.className = 'read';
  go.textContent = 'エピソードを読む';
  go.addEventListener('click', (e) => { e.stopPropagation(); confirmPlay(s); });
  card.append(th, sub, name, go);
  // like the game, text too long for its strip scrolls sideways
  requestAnimationFrame(() => marqueeAll([sub, ...name.children]));
  return card;
}

function marquee(el, over = el.scrollWidth - el.clientWidth) {
  if (over <= 2) return;
  const inner = document.createElement('span');
  inner.className = 'mq';
  inner.textContent = el.textContent;
  el.textContent = '';
  el.appendChild(inner);
  inner.style.setProperty('--mq', -over + 'px');
  inner.style.animationDuration = (4 + over / 25) + 's';
}

// many at once: read every width before changing any, so the page lays out once instead of once per element
function marqueeAll(els) {
  const over = els.map((el) => el.scrollWidth - el.clientWidth);
  els.forEach((el, i) => marquee(el, over[i]));
}

function svgIcon(kind) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  if (kind === 'search') s.innerHTML = '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/>';
  if (kind === 'note') s.innerHTML = '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>';
  return s;
}

function showSuspended() {
  const ids = Object.keys(bookmarks).filter((id) => T.byId.has(id));
  const wrap = document.createElement('div');
  wrap.className = 'search-results';
  const none = () => { wrap.innerHTML = '<p>中断中のエピソードはありません</p>'; };
  if (!ids.length) none();
  for (const id of ids) {
    const it = scenarioItem(T.byId.get(id));
    // × forgets where the story was suspended
    const del = document.createElement('span');
    del.className = 'del';
    del.setAttribute('role', 'button');
    del.setAttribute('aria-label', '中断データを削除');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      delete bookmarks[id];
      store.set('bookmarks', bookmarks);
      it.remove();
      if (!wrap.querySelector('.item')) none();
      renderMenu();
    });
    it.classList.add('has-del');
    it.appendChild(del);
    wrap.appendChild(it);
  }
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('.item:not(.missing)') && !e.target.closest('.info')) document.querySelector('.pop-overlay').remove();
  });
  popup({ title: '中断エピソード', body: wrap, wide: true });
}

function layerItem(l, unread) {
  let el;
  if (l.btn_img_path) {
    el = document.createElement('button');
    el.className = 'item banner';
    const im = new Image();
    im.alt = l.title || '';
    im.src = asset(l.btn_img_path);
    im.onerror = () => { const r = rowItem(l.img_path, l.subtitle, l.title); r.addEventListener('click', () => enter(l)); if (unread) r.appendChild(newBadge()); el.replaceWith(r); };
    // banner art leaves the left side blank for the title, which the game draws as text
    const cap = document.createElement('span');
    cap.className = 'cap';
    cap.textContent = l.title || '';
    el.append(im, cap);
  } else {
    el = rowItem(l.img_path, l.subtitle, l.title);
  }
  el.title = [l.title, l.subtitle].filter(Boolean).join(' ');
  if (unread) el.appendChild(newBadge());
  el.addEventListener('click', () => enter(l));
  el.addEventListener('contextmenu', (e) => showReadMenu(e, seriesOrder(l.key)));
  return el;
}

function scenarioItem(s) {
  const el = rowItem(s.img_path, s.subtitle, s.title || s.txt_path);
  el.dataset.id = s.scenario_id;
  if (!s.available) el.classList.add('missing');
  else if (!read.has(s.scenario_id)) el.appendChild(newBadge());
  if (bookmarks[s.scenario_id] != null) {
    el.appendChild(Object.assign(document.createElement('span'), { className: 'state', textContent: '中断中' }));
  }
  const info = document.createElement('span');
  info.className = 'info';
  info.textContent = 'i';
  info.addEventListener('click', (e) => { e.stopPropagation(); showInfo(s); });
  el.appendChild(info);
  el.addEventListener('click', () => {
    if (!s.available) { toast('このエピソードは未ダウンロードです'); return; }
    confirmPlay(s);
  });
  el.addEventListener('contextmenu', (e) => showReadMenu(e, [s]));
  return el;
}

function rowItem(img, tab, name) {
  const el = document.createElement('button');
  el.className = 'item row';
  const th = new Image();
  th.className = 'thumb';
  th.alt = '';
  if (img) { th.src = asset(img); th.onerror = () => { th.removeAttribute('src'); }; }
  const t = document.createElement('div'); t.className = 'tab'; t.textContent = tab || '';
  const n = document.createElement('div'); n.className = 'name'; n.textContent = name || '';
  if (!tab) el.classList.add('no-tab');
  el.append(th, t, n);
  return el;
}

// ---- right-click on a story (or a series / chapter): turn its NEW! off (mark read) or back on
function showReadMenu(e, stories) {
  e.preventDefault();
  e.stopPropagation();
  closeReadMenu();
  const ss = stories.filter((s) => s.available);
  if (!ss.length) return;
  const unread = ss.filter((s) => !read.has(s.scenario_id)).length;
  const box = document.createElement('div');
  box.className = 'ctx-menu';
  const add = (label, markRead) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); setRead(ss, markRead); closeReadMenu(); });
    box.appendChild(b);
  };
  if (ss.length === 1) add(unread ? 'NEW!を外す' : 'NEW!をつける', !!unread);
  else {
    if (unread) add(`すべてのNEW!を外す（${unread}話）`, true);
    if (unread < ss.length) add(`すべてにNEW!をつける（${ss.length - unread}話）`, false);
  }
  const screen = document.getElementById('screen');
  const r = screen.getBoundingClientRect();
  const k = r.width / 1136;
  screen.appendChild(box);
  const x = (e.clientX - r.left) / k, y = (e.clientY - r.top) / k;
  box.style.left = Math.min(x, 1136 - box.offsetWidth - 6) + 'px';
  box.style.top = Math.min(y, 640 - box.offsetHeight - 6) + 'px';
  const outside = (ev) => { if (!box.contains(ev.target)) closeReadMenu(); };
  const onKey = (ev) => { if (ev.key === 'Escape' || ev.key === 'Backspace') { ev.preventDefault(); ev.stopPropagation(); closeReadMenu(); } };
  closeReadMenu.off = () => {
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('wheel', closeReadMenu, true);
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('wheel', closeReadMenu, true);
  });
  window.addEventListener('keydown', onKey, true);
}
function closeReadMenu() {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  if (closeReadMenu.off) { closeReadMenu.off(); closeReadMenu.off = null; }
}
function setRead(stories, markRead) {
  for (const s of stories) { if (markRead) read.add(s.scenario_id); else read.delete(s.scenario_id); }
  store.set('read', [...read]);
  renderMenu();
  // story rows in an open dialog (search, 中断エピソード) update in place
  document.querySelectorAll('#popups .item[data-id]').forEach((el) => {
    const s = T.byId.get(el.dataset.id);
    const badge = el.querySelector('.new');
    const want = s && s.available && !read.has(s.scenario_id);
    if (want && !badge) el.appendChild(newBadge());
    else if (!want && badge) badge.remove();
  });
}

function newBadge() { const b = document.createElement('span'); b.className = 'new'; b.textContent = 'NEW!'; return b; }

function enter(l) { menu.path.push(l.key); renderMenu(); }
function menuBack() { if (menu.path.length) { menu.path.pop(); renderMenu(); } }

async function firstLoadable(names) {
  for (const n of names) { if (await loadImage(n)) return n; }
  return null;
}

function bindMenu() {
  document.getElementById('mBack').onclick = menuBack;
  document.getElementById('mHome').onclick = () => { menu.path = []; renderMenu(); };
  document.getElementById('mUnread').onclick = () => { menu.unreadOnly = !menu.unreadOnly; store.set('unreadOnly', menu.unreadOnly); renderMenu(); };
  document.getElementById('mHelp').onclick = showHelp;
  document.getElementById('mSettings').onclick = showSettings;
  document.getElementById('mSearch').onclick = showSearch;
  // the category row is wider than the screen: let the wheel scroll it sideways
  document.getElementById('mTop').addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.currentTarget.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });
}

// ---------------------------------------------------------------- popups
function popup({ title, body, buttons = [{ label: '閉じる', value: null, sub: true }], wide = false, backValue = null }) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'pop-overlay';
    const box = document.createElement('div');
    box.className = 'pop' + (wide ? ' wide' : '');
    const head = document.createElement('div'); head.className = 'pop-head'; head.textContent = title;
    const b = document.createElement('div'); b.className = 'pop-body';
    if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
    const foot = document.createElement('div'); foot.className = 'pop-foot';
    const close = (v) => { ov.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    for (const btn of buttons) {
      const e = document.createElement('button');
      e.className = 'pbtn' + (btn.sub ? ' sub' : '');
      e.innerHTML = btn.label;
      e.addEventListener('click', () => close(typeof btn.value === 'function' ? btn.value() : btn.value));
      foot.appendChild(e);
    }
    const onKey = (ev) => {
      ev.stopPropagation();
      if (globalKey(ev)) return;
      if (ev.key === 'Escape') { ev.preventDefault(); close(null); return; }
      const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox';
      // Backspace cancels the dialog, or does the dialog's own "back" action (e.g. back into the episode)
      if (ev.key === 'Backspace' && !typing) { ev.preventDefault(); close(backValue); return; }
      if ((ev.key === 'Enter' || ev.key === ' ') && !typing) {
        // Enter / Space pick the focused button, otherwise the dialog's main button
        ev.preventDefault();
        const focused = box.contains(document.activeElement) && document.activeElement.classList.contains('pbtn') ? document.activeElement : null;
        const target = focused || foot.querySelector('.pbtn:not(.sub)') || foot.querySelector('.pbtn');
        if (target) target.click();
      }
    };
    document.addEventListener('keydown', onKey, true);
    box.append(head, b, foot);
    ov.appendChild(box);
    ov.addEventListener('click', (e) => e.stopPropagation());
    // right-click closes the dialog (e.g. the backlog), like cancelling it
    ov.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); close(null); });
    document.getElementById('popups').appendChild(ov);
    const f = foot.querySelector('.pbtn:not(.sub)') || foot.querySelector('.pbtn');
    if (f) f.focus({ preventScroll: true });
    popup.box = b;
  });
}
const popupOpen = () => document.getElementById('popups').childElementCount > 0;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function confirmPlay(s) {
  const bm = bookmarks[s.scenario_id];
  const mins = Number(s.estimated_reading_time) || 0;
  let body = '<p>エピソードを再生しますか？</p>';
  if (mins) body += `<span class="pill-label">視聴目安時間</span><div class="value-box">${mins}分</div>`;
  if (bm != null) body += `<p><label><input type="checkbox" id="resumeChk" checked> 中断したところ（${bm + 1}ページ目）から再生する</label></p>`;
  const choice = await popup({
    title: 'エピソード再生', body,
    buttons: [
      { label: 'ボイスあり', value: () => ({ voice: true, resume: resumeChecked() }) },
      { label: 'ボイスなし', value: () => ({ voice: false, resume: resumeChecked() }) },
      { label: 'キャンセル', value: null, sub: true },
    ],
  });
  if (choice) playScenario(s, { voice: choice.voice, startPage: choice.resume ? bm : 0 });
}
function resumeChecked() { const c = document.getElementById('resumeChk'); return !!(c && c.checked); }

// エピソード詳細: the characters appearing in the story (main characters get the MAIN ring)
function showInfo(s) {
  const ids = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const main = ids(s.main_character_ids_string);
  const all = [...new Set([...main, ...ids(s.sub_character_ids_string)])];
  const wrap = document.createElement('div');
  wrap.innerHTML = '<span class="pill-label wide">登場キャラクター一覧</span>';
  const box = document.createElement('div');
  box.className = 'chara-box';
  for (const id of all) {
    const c = document.createElement('div');
    c.className = 'chara-ic' + (main.includes(id) ? ' main' : '');
    const ring = document.createElement('div');
    ring.className = 'ring';
    const im = new Image();
    im.alt = '';
    im.src = asset('ing_character_' + id.padStart(3, '0') + '_face.png.enc');
    ring.appendChild(im);
    if (main.includes(id)) ring.insertAdjacentHTML('beforeend', '<span class="main-tag">MAIN</span>');
    const n = document.createElement('div');
    n.className = 'nm';
    n.textContent = T.chars[id] || '';
    c.append(ring, n);
    box.appendChild(c);
  }
  if (!all.length) box.innerHTML = '<p>—</p>';
  wrap.appendChild(box);
  popup({ title: 'エピソード詳細', body: wrap, wide: true, buttons: [{ label: 'OK', value: null, sub: true }] });
}

function settingsBody() {
  const wrap = document.createElement('div');
  // speed sliders carry markers where the game's own settings sit (the default one highlighted); clicking a
  // marker sets the slider to it
  const rows = [
    ['textRate', 'テキスト速度', ['遅い', '普通', '速い', '最速'].map((name, i) => ({ v: TEXT_MARKS[i], name, def: i === 1 }))],
    ['autoRate', 'オート速度', [{ v: AUTO_DEFAULT, name: 'ゲームの速さ', def: true }]],
    ['voice', 'ボイス音量'], ['bgm', 'BGM音量'], ['se', 'SE音量'],
  ];
  for (const [k, label, marks] of rows) {
    const r = document.createElement('div');
    r.className = 'set-row';
    const vol = ['voice', 'bgm', 'se'].includes(k);
    r.innerHTML = `<label for="set_${k}">${label}</label><div class="set-range${vol ? ' vol' : ''}"><input id="set_${k}" type="range" min="0" max="100" value="${settings[k]}"></div><output>${settings[k]}</output>`;
    const inp = r.querySelector('input'), out = r.querySelector('output');
    // --p drives the pink fill up to the handle
    inp.style.setProperty('--p', settings[k] / 100);
    const set = (v) => { inp.value = v; inp.style.setProperty('--p', v / 100); settings[k] = Number(v); out.textContent = v; applySettings(); store.set('settings', settings); };
    inp.addEventListener('input', () => set(inp.value));
    for (const m of marks || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'set-mark' + (m.def ? ' def' : '');
      b.style.setProperty('--p', m.v);
      b.title = m.name + (m.def ? '（デフォルト）' : '');
      b.setAttribute('aria-label', label + ': ' + b.title);
      b.addEventListener('click', () => set(m.v));
      r.querySelector('.set-range').appendChild(b);
    }
    wrap.appendChild(r);
  }
  const nameRow = document.createElement('div');
  nameRow.className = 'set-row';
  nameRow.innerHTML = '<label for="set_name">プレイヤー名</label><input id="set_name" class="search-input" maxlength="12"><span></span>';
  const ni = nameRow.querySelector('input');
  ni.value = settings.playerName;
  ni.addEventListener('input', () => { settings.playerName = ni.value.trim() || 'あなた'; applySettings(); store.set('settings', settings); });
  wrap.appendChild(nameRow);
  const bgmRow = document.createElement('div');
  bgmRow.className = 'set-row';
  bgmRow.innerHTML = '<label for="set_mbgm">メニューBGM</label><select id="set_mbgm" class="search-input"></select><span></span>';
  const sel = bgmRow.querySelector('select');
  for (const c of [...MENU_BGMS, '']) sel.add(new Option(c ? c.replace('bgm_system_', 'システムBGM ') : 'なし', c));
  sel.value = settings.menuBgm == null ? DEFAULT_MENU_BGM : settings.menuBgm;
  sel.addEventListener('change', () => {
    settings.menuBgm = sel.value;
    store.set('settings', settings);
    if (!document.getElementById('menu').hidden) menuMusic(true);
  });
  wrap.appendChild(bgmRow);
  if (document.fullscreenEnabled) {
    const fsRow = document.createElement('div');
    fsRow.className = 'set-row';
    fsRow.innerHTML = '<label>フルスクリーン</label><button type="button" class="pbtn set-fs"></button><span></span>';
    const fb = fsRow.querySelector('button');
    const sync = () => {
      if (fsRow.parentNode && !fsRow.isConnected) return document.removeEventListener('fullscreenchange', sync);
      fb.textContent = document.fullscreenElement ? 'オフにする' : 'オンにする';
    };
    sync();
    fb.addEventListener('click', toggleFull);
    document.addEventListener('fullscreenchange', sync);
    wrap.appendChild(fsRow);
  }
  const note = document.createElement('div');
  note.className = 'set-note';
  note.textContent = '設定はこのブラウザに保存されます';
  wrap.appendChild(note);
  return wrap;
}
function showSettings() { return popup({ title: '設定', body: settingsBody() }); }

function applySettings() {
  if (!player) return;
  player.playerName = settings.playerName;
  player.textDelay = testTextSpeed >= 1 ? 0 : textDelayFor(settings.textRate);
  player.autoScale = autoScaleFor(settings.autoRate);
  player.audio.setVolume('voice', voiceOff ? 0 : settings.voice / 100);
  player.audio.setVolume('bgm', settings.bgm / 100);
  player.audio.setVolume('se', settings.se / 100);
}

function showHelp() {
  popup({
    title: '操作方法', wide: true,
    body: `<div class="keys">
      <span><kbd>クリック</kbd> <kbd>Space</kbd> <kbd>Enter</kbd></span><span>次へ</span>
      <span><kbd>←</kbd> <kbd>Backspace</kbd></span><span>ひとつ前のページへ戻る</span>
      <span><kbd>Ctrl</kbd>（押している間）</span><span>早送り</span>
      <span><kbd>A</kbd></span><span>オート</span>
      <span><kbd>L</kbd> / ホイール上</span><span>ログ・巻戻し</span>
      <span><kbd>H</kbd> / 右クリック</span><span>すべて非表示</span>
      <span><kbd>Esc</kbd></span><span>MENU の開閉 / ポップアップを閉じる</span>
      <span><kbd>F</kbd></span><span>フルスクリーン</span>
    </div>
    <p class="set-note">新しいエピソードはゲーム内で一括DLしてから sync.py を実行してください</p>`,
  });
}

function showSearch() {
  const wrap = document.createElement('div');
  const inp = document.createElement('input');
  inp.className = 'search-input';
  inp.placeholder = 'タイトル・サブタイトルで検索';
  const res = document.createElement('div');
  res.className = 'search-results';
  wrap.append(inp, res);
  const all = [...T.byId.values()];
  const pathOf = (s) => {
    const names = [];
    let l = T.layers.get(s.key);
    while (l) { names.unshift([l.title, l.subtitle].filter(Boolean).join(' ')); l = T.layers.get(l.parentKey); }
    return names.filter(Boolean).join(' > ');
  };
  // match on the story's own text and on the names of the layers it sits in (series, chapter)
  const haystack = new Map(all.map((s) => [s, [s.title, s.subtitle, s.txt_path, pathOf(s)].join('\n').toLowerCase()]));
  const run = () => {
    const words = inp.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    res.innerHTML = '';
    if (!words.length) return;
    const matches = all.filter((s) => words.every((w) => haystack.get(s).includes(w)));
    const hits = matches.slice(0, 80);
    if (matches.length > hits.length) {
      const more = document.createElement('p');
      more.textContent = `${matches.length}件中 ${hits.length}件を表示`;
      res.appendChild(more);
    }
    if (!hits.length) { res.innerHTML = '<p>見つかりませんでした</p>'; return; }
    hits.sort((a, b) => byId(a, b));
    for (const s of hits) {
      const it = scenarioItem(s);
      const p = document.createElement('div');
      p.className = 'path';
      p.textContent = pathOf(s);
      res.append(it, p);
    }
  };
  let t;
  inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 150); });
  popup({ title: '検索', body: wrap, wide: true });
  setTimeout(() => inp.focus(), 50);
  res.addEventListener('click', (e) => {
    if (e.target.closest('.item:not(.missing)') && !e.target.closest('.info')) document.querySelector('.pop-overlay').remove();
  });
}

// ---------------------------------------------------------------- adv
// episodes reached via 次のエピソードへ, so going back from the first page returns to the previous one
const chain = [];

async function playScenario(s, { voice = true, startPage = 0, history = null, fromChain = false } = {}) {
  const r = await fetch('/api/script/' + encodeURIComponent(s.scenario_id));
  if (!r.ok) { toast('エピソードを読み込めませんでした'); return; }
  const { script } = await r.json();
  if (!fromChain) chain.length = 0;
  current = s;
  voiceOff = !voice;
  applySettings();
  document.getElementById('menu').hidden = true;
  const adv = document.getElementById('adv');
  adv.hidden = false;
  adv.classList.remove('ui-hidden', 'toolbar-open');
  document.getElementById('toolbar').hidden = true;
  document.title = (s.title || s.txt_path) + ' – Story Viewer';
  await player.load(script, s, startPage || 0, history);
}

function backToPreviousEpisode() {
  const prev = chain.pop();
  if (!prev) return;
  const last = prev.history[prev.history.length - 1];
  playScenario(prev.s, { voice: !voiceOff, startPage: last, history: prev.history, fromChain: true });
}

function backToMenu() {
  player.stop();
  // return to the list containing the episode being played (which may differ from the one
  // originally opened, after following 次のエピソードへ)
  if (current) {
    const path = [];
    for (let l = T.layers.get(current.key); l; l = T.layers.get(l.parentKey)) path.unshift(l.key);
    if (path.length) menu.path = path;
  }
  current = null;
  chain.length = 0;
  document.getElementById('adv').hidden = true;
  document.getElementById('menu').hidden = false;
  document.title = 'Story Viewer';
  renderMenu();
  menuMusic(true);
}

// reading order of a whole series (same top-level layer), in menu order: finishing the last story
// of a chapter continues into the next chapter, like the game
function seriesOrder(rootKey) {
  const out = [];
  const walk = (k) => {
    for (const s of T.scns.get(k) || []) out.push(s);
    for (const l of T.kids.get(k) || []) walk(l.key);
  };
  walk(rootKey);
  return out;
}
function rootOf(layerKey) {
  let l = T.layers.get(layerKey);
  while (l && T.layers.has(l.parentKey)) l = T.layers.get(l.parentKey);
  return l;
}
function nextScenarioAfter(s) {
  const root = rootOf(s.key);
  if (!root) return null;
  const order = seriesOrder(root.key);
  for (let i = order.indexOf(s) + 1; i > 0 && i < order.length; i++) if (order[i].available) return order[i];
  return null;
}

async function onEpisodeEnd() {
  const s = current;
  if (!s) return;
  read.add(s.scenario_id);
  store.set('read', [...read]);
  delete bookmarks[s.scenario_id];
  store.set('bookmarks', bookmarks);
  const next = nextScenarioAfter(s);
  const v = await popup({
    title: 'エピソード終了',
    body: `<p>${esc(s.title)}</p>` + (next ? `<p style="color:#1a72e2">次のエピソード：${esc(next.subtitle)} ${esc(next.title)}</p>` : ''),
    buttons: [
      ...(next ? [{ label: '次のエピソードへ', value: 'next' }] : []),
      { label: 'もう一度見る', value: 'again', sub: true },
      { label: '一覧に戻る', value: 'menu', sub: true },
    ],
    backValue: 'back',
  });
  // Backspace: return to the last line of this episode
  if (v === 'back') { player.back(true); return; }
  if (v === 'next') {
    chain.push({ s, history: player.history.slice() });
    playScenario(next, { voice: !voiceOff, fromChain: true });
  }
  else if (v === 'again') playScenario(s, { voice: !voiceOff });
  else backToMenu();
}

function openToolbar(open) {
  const adv = document.getElementById('adv');
  adv.classList.toggle('toolbar-open', open);
  document.getElementById('toolbar').hidden = !open;
}

// ログ・巻戻し in the game's layout: speaker face + name on the left, the line in a bubble on the right,
// current line outlined in pink. Each row keeps ▶ボイス / 巻戻し buttons.
function showLog() {
  const entries = player.logEntries();
  if (!entries.length) return;
  const ov = document.createElement('div');
  ov.className = 'pop-overlay log-overlay';
  const panel = document.createElement('div');
  panel.className = 'log-panel';
  const list = document.createElement('div');
  list.className = 'log-rows';
  const adv = document.getElementById('adv');
  adv.classList.add('log-open');
  const close = () => { ov.remove(); adv.classList.remove('log-open'); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    e.stopPropagation();
    if (globalKey(e)) return;
    if (['Escape', 'l', 'L', 'Backspace'].includes(e.key)) { e.preventDefault(); close(); }
    // wheel-like scrolling with the keyboard
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); list.scrollTop += e.key === 'ArrowDown' ? 160 : -160; }
  };
  for (const { i, p } of entries) {
    const row = document.createElement('div');
    row.className = 'log-row' + (i === player.index ? ' current' : '');
    const who = document.createElement('div');
    who.className = 'who';
    const name = player.subst((p.TextArea.Name || '').trim());
    // AdvLogScrollListNode.renderSpeakerChara: with an IsSpeaker chara the icon and the name under it show;
    // without one both hide and the name goes in NoSpeakerName, centred in the left column instead
    const hasSpeaker = (p.Charas || []).some((c) => c && c.IsSpeaker);
    const nm = document.createElement('div');
    nm.className = hasSpeaker ? 'nm' : 'nsn';
    nm.textContent = name;
    if (hasSpeaker) {
      const face = document.createElement('div');
      face.className = 'face';
      who.append(face, nm);
      player.speakerFace(p).then((c) => { if (c) face.appendChild(c); });
    } else {
      row.appendChild(nm);
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = player.subst(p.TextArea.Dialogue || '');
    const acts = document.createElement('div');
    acts.className = 'acts';
    const voice = p.Sound && p.Sound.VoiceFileName;
    if (voice) {
      const vb = document.createElement('button'); vb.textContent = '▶ ボイス';
      vb.onclick = (e) => { e.stopPropagation(); player.audio.playVoice(voice); };
      acts.appendChild(vb);
    }
    if (i !== player.index) {
      const rb = document.createElement('button'); rb.textContent = '巻戻し';
      rb.onclick = (e) => { e.stopPropagation(); close(); player.rewindTo(i); };
      acts.appendChild(rb);
    }
    bubble.append(t, acts);
    row.append(who, bubble);
    list.appendChild(row);
  }
  const x = document.createElement('button');
  x.className = 'log-close';
  x.setAttribute('aria-label', '閉じる');
  x.onclick = close;
  panel.append(list, x);
  ov.appendChild(panel);
  ov.addEventListener('click', (e) => { e.stopPropagation(); if (e.target === ov) close(); });
  ov.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); close(); });
  document.addEventListener('keydown', onKey, true);
  document.getElementById('popups').appendChild(ov);
  // the names are TMP auto-size (max 19): shrink until they fit their box
  // (NoSpeakerName wraps inside 159x30, the name under the icon stays on one line inside 105)
  for (const el of list.querySelectorAll('.nm, .nsn')) {
    const maxH = el.classList.contains('nsn') ? 30 : Infinity;
    for (let s = 19; s > 8 && (el.scrollWidth > el.clientWidth + 0.5 || el.offsetHeight > maxH); s -= 0.5) el.style.fontSize = s - 0.5 + 'px';
  }
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

async function skipEpisode() {
  const ok = await popup({ title: 'スキップ', body: '<p>エピソードをスキップしますか？</p>', buttons: [{ label: 'スキップ', value: true }, { label: 'キャンセル', value: false, sub: true }] });
  if (ok) player.finish(true);
}

async function quitEpisode() {
  const ok = await popup({ title: '中断する', body: '<p>エピソードを中断しますか？</p><p style="font-size:16px;color:#7a8698">次回は中断したところから再生できます</p>', buttons: [{ label: '中断する', value: true }, { label: 'キャンセル', value: false, sub: true }] });
  if (!ok) return;
  if (current && player.index > 0) { bookmarks[current.scenario_id] = player.index; store.set('bookmarks', bookmarks); }
  backToMenu();
}

function toggleHideAll() {
  const adv = document.getElementById('adv');
  adv.classList.toggle('ui-hidden');
}

// ---- movie controls (SKIP / play-pause / seek), shown when the movie is tapped. Also used by the
// サウンドプレイヤー's movie list, with its own copy of the controls (root) and video.
function movieControls(root, video, onSkip) {
  const q = (c) => root.querySelector(c);
  // InlineMovieMenuAnimation: each tap toggles the menu (it never hides by itself); SKIP fades in from 150px right
  // and the bar below from 100px down, 0.2 s linear (DoTweenFadeAnimator), and hiding plays them in reverse
  const parts = [[q('.mv-skip'), '150px 0'], ...['.mv-pause', '.mv-bar', '.mv-time'].map((c) => [q(c), '0 100px'])];
  let shown = false;
  const animate = (show) => {
    const opts = { duration: 200, easing: 'linear', fill: 'both' };
    for (const [el] of parts) for (const a of el.getAnimations()) a.cancel();
    const anims = parts.map(([el, from]) => el.animate(
      show ? [{ translate: from, opacity: 0 }, { translate: '0 0', opacity: 1 }]
        : [{ translate: '0 0', opacity: 1 }, { translate: from, opacity: 0 }], opts));
    return anims[0].finished.catch(() => {});
  };
  const ui = {
    root,
    video,
    show() {
      ui.update();
      if (shown) return;
      shown = true;
      root.hidden = false;
      animate(true);
    },
    // instant: closing with the movie (skip / end), where the game drops the menu with it
    hide(instant = true) {
      if (!shown) return;
      shown = false;
      if (instant) { root.hidden = true; return; }
      animate(false).then(() => { if (!shown) root.hidden = true; });
    },
    toggle() { if (shown) ui.hide(false); else ui.show(); },
    update() {
      const fmt = (t) => { t = Math.max(0, Math.floor(t || 0)); return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
      q('.mv-time .cur').textContent = fmt(video.currentTime);
      q('.mv-time .tot').textContent = fmt(video.duration);
      const f = video.duration ? video.currentTime / video.duration : 0;
      // the game's Slider: the handle's centre at f of the bar, the gauge filling f of the bar less 2px each side
      q('.mv-thumb').style.left = (f * 601) + 'px';
      q('.mv-track').style.setProperty('--f', f);
      q('.mv-pause').classList.toggle('paused', video.paused);
    },
  };
  video.addEventListener('timeupdate', () => { if (!root.hidden) ui.update(); });
  video.addEventListener('play', () => ui.update());
  video.addEventListener('pause', () => ui.update());
  const on = (c, fn) => q(c).addEventListener('click', (e) => { e.stopPropagation(); fn(e); });
  on('.mv-skip', () => { ui.hide(); onSkip(); });
  on('.mv-pause', () => { if (video.paused) video.play().catch(() => {}); else video.pause(); ui.show(); });
  const bar = q('.mv-bar');
  const seek = (e) => {
    const r = bar.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (video.duration) video.currentTime = f * video.duration;
    ui.show();
  };
  bar.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    bar.setPointerCapture(e.pointerId);
    seek(e);
    const move = (ev) => seek(ev);
    const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  });
  bar.addEventListener('click', (e) => e.stopPropagation());
  return ui;
}

let mvui;
function bindMovieUi() {
  mvui = movieControls(document.getElementById('movieui'), document.getElementById('movie'), () => { if (player.skipMovie) player.skipMovie(); });
  player.onMovie = (playing) => { if (!playing) mvui.hide(); };
}

function bindAdv() {
  const adv = document.getElementById('adv');
  const stage = document.getElementById('stage');
  bindMovieUi();
  stage.addEventListener('click', (e) => {
    if (adv.classList.contains('movie-playing')) { mvui.toggle(); return; }
    if (e.target.closest('#choices button')) return;
    if (adv.classList.contains('ui-hidden')) { adv.classList.remove('ui-hidden'); return; }
    if (player.mode === 'fast') { player.setMode('normal'); return; }
    player.next();
  });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('wheel', (e) => {
    if (popupOpen()) return;
    if (e.deltaY > 0) player.next(); else if (e.deltaY < 0) showLog();
  }, { passive: true });

  const on = (id, fn) => document.getElementById(id).addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  on('menuBtn', () => openToolbar(true));
  on('tbClose', () => openToolbar(false));
  on('tbSettings', showSettings);
  on('tbSkip', skipEpisode);
  on('tbAuto', () => player.setMode('auto'));
  on('tbFast', () => player.setMode('fast'));
  on('tbLog', showLog);
  on('tbHide', toggleHideAll);
  on('tbQuit', quitEpisode);
}

function onPlayerChange() {
  document.getElementById('tbAuto').classList.toggle('on', player.mode === 'auto');
  document.getElementById('tbFast').classList.toggle('on', player.mode === 'fast');
  const icon = document.getElementById('modeIcon');
  icon.classList.toggle('auto', player.mode === 'auto');
  icon.classList.toggle('fast', player.mode === 'fast');
}

// keys that work in every state (menu, story, movie, dialogs, backlog); returns true if handled
function globalKey(e) {
  const typing = e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && !['range', 'checkbox'].includes(e.target.type);
  if (typing || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFull(); return true; }
  return false;
}

function bindKeys() {
  let ctrlFast = false;
  // a clicked button keeps keyboard focus, and Space/Enter would then press it again instead of
  // advancing the story; drop focus after every mouse click on a button
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (b && e.detail > 0) b.blur();
  }, true);
  document.addEventListener('keydown', (e) => {
    // dialogs and the backlog handle their own keys (and call globalKey for F)
    if (popupOpen()) return;
    if (globalKey(e)) return;
    if (!document.getElementById('mvx').hidden) { movieKey(e); return; }
    if (!document.getElementById('snd').hidden) { soundKey(e); return; }
    const adv = document.getElementById('adv');
    if (adv.hidden) {
      if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); menuBack(); }
      return;
    }
    // full-screen movie: Space / Enter / Esc / → show the controls, Backspace / ← go back past it
    if (adv.classList.contains('movie-playing')) {
      if ([' ', 'Enter', 'Escape', 'ArrowRight', 'PageDown'].includes(e.key)) { e.preventDefault(); mvui.toggle(); }
      else if (['Backspace', 'ArrowLeft', 'PageUp'].includes(e.key)) {
        e.preventDefault();
        mvui.hide();
        if (player.skipMovie) player.skipMovie();
        player.back();
      }
      return;
    }
    // choices on screen: 1-9 pick, ↑/↓ move, Space / Enter pick the highlighted (or first) one
    const choices = [...document.querySelectorAll('#choices button')];
    if (choices.length) {
      const at = choices.indexOf(document.activeElement);
      if (/^[1-9]$/.test(e.key) && choices[Number(e.key) - 1]) { e.preventDefault(); choices[Number(e.key) - 1].click(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = e.key === 'ArrowDown' ? (at + 1) % choices.length : (at <= 0 ? choices.length - 1 : at - 1);
        choices[n].focus();
        return;
      }
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); (choices[at] || choices[0]).click(); return; }
    }
    if (e.key === 'Control' && !e.repeat) { if (player.mode !== 'fast') { ctrlFast = true; player.setMode('fast'); } return; }
    switch (e.key) {
      case ' ': case 'Enter': case 'ArrowRight': case 'PageDown':
        e.preventDefault();
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        if (adv.classList.contains('ui-hidden')) { toggleHideAll(); return; }
        player.next(); break;
      case 'ArrowLeft': case 'PageUp': case 'Backspace': e.preventDefault(); player.back(); break;
      case 'a': case 'A': player.setMode('auto'); break;
      case 'l': case 'L': showLog(); break;
      case 'h': case 'H': toggleHideAll(); break;
      case 'Escape': openToolbar(!adv.classList.contains('toolbar-open')); break;
      default:
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Control' && ctrlFast) { ctrlFast = false; if (player.mode === 'fast') player.setMode('normal'); }
  });
  window.addEventListener('blur', () => { if (ctrlFast) { ctrlFast = false; if (player.mode === 'fast') player.setMode('normal'); } });
}

// ---------------------------------------------------------------- menu music, button sounds, tap ring
// the game's system sounds: BuiltIn.acb se_001 = ButtonTap, se_002 = ButtonCancel (SE enum);
// menu music defaults to bgm_system_006 (selectable in 設定; the game has no bgm_system_003)
const SE_TAP = 'BuiltIn.acb@se_001', SE_CANCEL = 'BuiltIn.acb@se_002';
const MENU_BGMS = ['bgm_system_001', 'bgm_system_002', 'bgm_system_004', 'bgm_system_005', 'bgm_system_006', 'bgm_system_007', 'bgm_system_008', 'bgm_system_009'];
const DEFAULT_MENU_BGM = 'bgm_system_006';

function menuMusic(on) {
  const cue = settings.menuBgm == null ? DEFAULT_MENU_BGM : settings.menuBgm;
  player.audio.setBgm(on && cue ? cue : null);
}

function bindUiSound() {
  const screen = document.getElementById('screen');
  screen.addEventListener('pointerdown', (e) => {
    player.audio.ensure();
    if (!document.getElementById('menu').hidden && !player.audio.bgm) menuMusic(true);
    // the game's green ripple where you tap
    const r = screen.getBoundingClientRect();
    const k = r.width / 1136;
    const ring = document.createElement('div');
    ring.className = 'tap-ring';
    ring.style.left = (e.clientX - r.left) / k + 'px';
    ring.style.top = (e.clientY - r.top) / k + 'px';
    screen.appendChild(ring);
    setTimeout(() => ring.remove(), 500);
  }, true);
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.del, button, .item');
    if (!b || !screen.contains(b) || b.classList.contains('mv-pause')) return;
    const cancel = b.matches('#mBack, #sBack, #tbClose, .pbtn.sub, .del') || /キャンセル|閉じる/.test(b.textContent);
    player.audio.se(cancel ? SE_CANCEL : SE_TAP);
  }, true);
}

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
}

init().catch((e) => { document.getElementById('mList').textContent = '読み込みに失敗しました: ' + e.message; });
