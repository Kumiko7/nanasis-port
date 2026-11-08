'use strict';

// サウンドプレイヤー, laid out like the game's scene (level101): groups (categories, then playlists) on the
// left, the group's songs in the middle, the player on the right. Playlists live in this browser, with
// the game's limits (10 playlists, 300 songs each). Songs play on the BGM channel, so BGM音量 applies.
// The ムービー tab (not in the game) lists the story's full-screen movies and plays them with the sound the story
// plays with them.
// Relies on app.js / player.js globals: store, player, popup, toast, asset, menuMusic, renderMenu, marquee,
// movieControls, playScenario, T.

const snd = {
  data: null,
  movies: [],
  byKey: new Map(),         // '<category>:<id>' -> track (ids alone repeat across categories)
  playlists: [],             // [{ id, name, keys: [track key, ...] }]
  group: '1',                // shown group: a category id, or 'p<playlist id>'
  shuffle: false,
  repeat: 'off',             // off -> all -> single (SoundPlayerRepeatMode Once / RepeatAll / RepeatSingle)
  // playback
  queue: [], queueGroup: null, order: [], pos: -1,
  track: null, buf: null, src: null, startedAt: 0, offset: 0, playing: false, loadToken: null,
  eqTimer: null, tick: null,
};
const SND_REPEAT = ['off', 'all', 'single'];

// tracks and movies, fetched once (app.js starts this when the viewer is idle)
let soundData = null;
function loadSoundData() {
  if (!soundData) {
    soundData = Promise.all([fetch('/api/sounds'), fetch('/api/movies')])
      .then(async ([r, rm]) => (r.ok ? { sounds: await r.json(), movies: rm.ok ? await rm.json() : [] } : null))
      .catch(() => null);
    soundData.then((d) => { if (!d) soundData = null; });   // try again on the next open
  }
  return soundData;
}

async function openSound() {
  if (!snd.data) {
    const d = await loadSoundData();
    if (!d) { toast('サウンドデータを読み込めませんでした'); return; }
    snd.data = d.sounds;
    // looping movies are animated backgrounds (confetti, rain, swirls), not worth watching on their own
    snd.movies = d.movies.filter((m) => m.available && !m.loop);
    for (const t of snd.data.sounds) snd.byKey.set(t.key, t);
    snd.playlists = store.get('playlists', []).map((p) => ({ id: p.id, name: p.name, keys: (p.keys || []).filter((k) => snd.byKey.has(k)) }));
    snd.shuffle = store.get('sndShuffle', false);
    snd.repeat = store.get('sndRepeat', 'off');
    snd.group = store.get('sndGroup', '1');
    if (!groupExists(snd.group)) snd.group = snd.data.categories[0].category;
    bindSound();
  }
  document.getElementById('menu').hidden = true;
  document.getElementById('snd').hidden = false;
  document.title = 'サウンドプレイヤー – Story Viewer';
  player.audio.setBgm(null);   // the menu music makes way for the player
  renderGroups();
  renderSongs();
  renderPlayer();
}

function closeSound() {
  closeMovie();
  closeSubMenu();
  stopTrack();
  snd.track = null;
  snd.buf = null;
  document.getElementById('snd').hidden = true;
  document.getElementById('menu').hidden = false;
  document.title = 'Story Viewer';
  renderMenu();
  menuMusic(true);
}

// scrolling titles of the rows just built, measured together in the next frame
let marqueeQueue = [];
function queueMarquee(...els) {
  if (!marqueeQueue.length) requestAnimationFrame(() => { const q = marqueeQueue; marqueeQueue = []; marqueeAll(q.filter((e) => e.isConnected)); });
  marqueeQueue.push(...els);
}

// ---------------------------------------------------------------- groups (left)
const MOVIES = 'movies';
const isPlaylist = (g) => g[0] === 'p';
const playlistOf = (g) => snd.playlists.find((p) => 'p' + p.id === g);
function groupExists(g) {
  if (g === MOVIES) return snd.movies.length > 0;
  return isPlaylist(g) ? !!playlistOf(g) : snd.data.categories.some((c) => c.category === g);
}
function groupSongs(g) {
  if (isPlaylist(g)) { const p = playlistOf(g); return p ? p.keys.map((k) => snd.byKey.get(k)).filter(Boolean) : []; }
  return snd.data.sounds.filter((t) => t.category === g);
}
function savePlaylists() { store.set('playlists', snd.playlists); }

function renderGroups() {
  const box = document.getElementById('sGroups');
  const keep = box.scrollTop;
  box.innerHTML = '';
  const node = (g, name, count) => {
    const n = document.createElement('div');
    n.className = 's-group' + (g === snd.group ? ' on' : '');
    n.dataset.group = g;
    const b = document.createElement('button');
    b.className = 's-group-btn';
    const eq = document.createElement('div');
    eq.className = 's-eq';
    for (let i = 0; i < 13; i++) eq.appendChild(document.createElement('i'));
    const label = document.createElement('div');
    label.className = 's-group-name';
    label.textContent = name;
    b.append(eq, label);
    if (count != null) {
      const c = document.createElement('span');
      c.className = 's-count' + (count >= snd.data.maxPerPlaylist ? ' max' : '');
      c.textContent = count + '曲';
      b.appendChild(c);
    }
    b.addEventListener('click', () => selectGroup(g));
    n.appendChild(b);
    if (isPlaylist(g)) {
      const m = document.createElement('button');
      m.className = 's-group-menu';
      m.setAttribute('aria-label', 'プレイリスト編集');
      m.addEventListener('click', (e) => { e.stopPropagation(); playlistMenu(g, n); });
      n.appendChild(m);
    }
    box.appendChild(n);
    queueMarquee(label);
  };
  for (const c of snd.data.categories) node(c.category, c.name, null);
  if (snd.movies.length) node(MOVIES, 'ムービー', null);
  for (const p of snd.playlists) node('p' + p.id, p.name, p.keys.length);
  const foot = document.createElement('div');
  foot.className = 's-group-foot';
  const add = document.createElement('button');
  add.className = 's-add-list';
  add.textContent = 'プレイリスト作成';
  add.disabled = snd.playlists.length >= snd.data.maxPlaylists;
  add.addEventListener('click', createPlaylist);
  foot.appendChild(add);
  box.appendChild(foot);
  box.scrollTop = keep;
  updateEqualizer();
}

function selectGroup(g) {
  if (snd.group === g) return;
  closeSubMenu();
  snd.group = g;
  store.set('sndGroup', g);
  document.querySelectorAll('.s-group').forEach((n) => n.classList.toggle('on', n.dataset.group === g));
  renderSongs();
  document.getElementById('sList').scrollTop = 0;
}

function createPlaylist(select = true) {
  if (snd.playlists.length >= snd.data.maxPlaylists) return null;
  const id = snd.playlists.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  // default names follow the game's 'プレイリスト{0}'
  let n = 1;
  while (snd.playlists.some((p) => p.name === 'プレイリスト' + n)) n++;
  const p = { id, name: 'プレイリスト' + n, keys: [] };
  snd.playlists.push(p);
  savePlaylists();
  if (select) { snd.group = 'p' + id; store.set('sndGroup', snd.group); renderSongs(); }
  renderGroups();
  if (select) { const box = document.getElementById('sGroups'); box.scrollTop = box.scrollHeight; }
  return p;
}

// ---------------------------------------------------------------- songs (centre)
function renderSongs() {
  const list = document.getElementById('sList');
  list.innerHTML = '';
  if (snd.group === MOVIES) { document.getElementById('sEmpty').hidden = true; renderMovies(); return; }
  const songs = groupSongs(snd.group);
  document.getElementById('sEmpty').hidden = songs.length > 0;
  songs.forEach((t, i) => list.appendChild(songRow(t, i)));
  markPlayingRow();
}

function songRow(t, i) {
  const row = document.createElement('div');
  row.className = 's-row';
  row.dataset.index = i;
  row.dataset.key = t.key;
  const jk = new Image();
  jk.className = 's-row-jacket';
  jk.alt = '';
  jk.loading = 'lazy';   // only the rows in view fetch their jacket
  jk.src = asset(t.image);
  jk.onerror = () => { jk.src = '/ui/jacket_empty.png'; };
  const name = document.createElement('div');
  name.className = 's-row-name';
  name.textContent = t.name;
  const line = document.createElement('i');
  line.className = 's-row-line';
  const artist = document.createElement('div');
  artist.className = 's-row-artist';
  artist.textContent = t.artist;
  const opt = document.createElement('button');
  opt.className = 's-row-menu';
  opt.setAttribute('aria-label', 'メニュー');
  opt.addEventListener('click', (e) => { e.stopPropagation(); songMenu(t, i, row); });
  row.append(jk, name, line, artist, opt);
  bindRowDrag(row, t, i);
  queueMarquee(name, artist);
  return row;
}

function markPlayingRow() {
  const here = snd.queueGroup === snd.group && snd.track;
  document.querySelectorAll('#sList .s-row').forEach((r) => {
    r.classList.toggle('on', !!here && Number(r.dataset.index) === snd.order[snd.pos]);
  });
}

// ---------------------------------------------------------------- sub menus (••• on songs / playlists)
// the game dims the screen, keeps a copy of the tapped node above the dimming, and opens the popup beside it
function openSubMenu(anchor, popupEl, left, height) {
  closeSubMenu();
  const sc = document.getElementById('snd');
  const mask = document.getElementById('sMask');
  mask.hidden = false;
  const k = sc.getBoundingClientRect().width / 1136;
  const r = anchor.getBoundingClientRect();
  const s = sc.getBoundingClientRect();
  const top = (r.top - s.top) / k, h = r.height / k;
  const ghost = anchor.cloneNode(true);
  ghost.classList.add('s-ghost');
  Object.assign(ghost.style, { left: (r.left - s.left) / k + 'px', top: top + 'px', width: r.width / k + 'px', height: h + 'px' });
  ghost.querySelectorAll('.mq').forEach((m) => { m.style.animation = 'none'; });
  mask.appendChild(ghost);
  popupEl.classList.add('s-sub');
  popupEl.style.left = left + 'px';
  popupEl.style.top = Math.max(84, Math.min(632 - height, top + h / 2 - height / 2)) + 'px';
  popupEl.style.height = height + 'px';
  popupEl.addEventListener('click', (e) => e.stopPropagation());
  mask.appendChild(popupEl);
  mask.onclick = closeSubMenu;
  mask.oncontextmenu = (e) => { e.preventDefault(); closeSubMenu(); };
}
function closeSubMenu() {
  const mask = document.getElementById('sMask');
  if (!mask || mask.hidden) return false;
  mask.hidden = true;
  mask.innerHTML = '';
  return true;
}

function songMenu(t, i, row) {
  const inList = isPlaylist(snd.group);
  const pop = document.createElement('div');
  pop.className = 's-sub-song' + (inList ? ' in-list' : '');
  pop.innerHTML = `<div class="s-sub-head">追加先プレイリスト</div>
    <select class="s-dropdown"></select>
    <button class="s-sub-btn blue add">追加</button>
    ${inList ? '<button class="s-sub-btn white remove">プレイリストから削除</button>' : ''}`;
  const sel = pop.querySelector('select');
  for (const p of snd.playlists) sel.add(new Option(p.name, p.id));
  // no playlist yet: adding creates one (named like the game's default)
  if (!snd.playlists.length) sel.add(new Option('新規プレイリスト', 'new'));
  const last = store.get('sndAddTo', null);
  if (last != null && snd.playlists.some((p) => String(p.id) === String(last))) sel.value = String(last);
  pop.querySelector('.add').addEventListener('click', () => {
    let p = sel.value === 'new' ? createPlaylist(false) : snd.playlists.find((x) => String(x.id) === sel.value);
    if (!p) return;
    store.set('sndAddTo', p.id);
    if (addToPlaylist(p, [t.key])) toast(`「${p.name}」に追加しました`);
    closeSubMenu();
  });
  const rm = pop.querySelector('.remove');
  if (rm) rm.addEventListener('click', () => { removeFromPlaylist(playlistOf(snd.group), i); closeSubMenu(); });
  openSubMenu(row, pop, 588, inList ? 214 : 138);
}

function playlistMenu(g, node) {
  const p = playlistOf(g);
  if (!p) return;
  const pop = document.createElement('div');
  pop.className = 's-sub-list';
  pop.innerHTML = `<div class="s-sub-head">プレイリスト編集</div>
    <label class="s-name"><input maxlength="20" spellcheck="false"><i></i></label>
    <button class="s-sub-btn blue quick">クイック追加</button>
    <button class="s-sub-btn white del">プレイリスト削除</button>`;
  const inp = pop.querySelector('input');
  inp.value = p.name;
  const commit = () => {
    const v = inp.value.trim();
    if (v && v !== p.name) { p.name = v; savePlaylists(); renderGroups(); }
  };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); inp.blur(); } });
  pop.querySelector('.quick').addEventListener('click', () => { commit(); closeSubMenu(); quickAdd(p); });
  pop.querySelector('.del').addEventListener('click', async () => {
    commit();
    closeSubMenu();
    const ok = await popup({ title: 'プレイリスト削除', body: `<p>「${esc(p.name)}」を削除しますか？</p>`, buttons: [{ label: '削除', value: true }, { label: 'キャンセル', value: false, sub: true }] });
    if (!ok) return;
    snd.playlists = snd.playlists.filter((x) => x !== p);
    savePlaylists();
    remapQueue(g, () => -1);
    if (snd.group === g) { snd.group = snd.data.categories[0].category; store.set('sndGroup', snd.group); renderSongs(); }
    renderGroups();
  });
  openSubMenu(node, pop, 240, 220);
}

// after the playing playlist changes, point the queue at the edited list; `map` gives the playing song's
// new index (-1 if it was removed: it plays on, detached from the list)
function remapQueue(g, map) {
  if (snd.queueGroup !== g || !snd.track) return;
  const at = map(snd.order[snd.pos]);
  if (at < 0) { snd.queueGroup = null; updateEqualizer(); return; }
  snd.queue = groupSongs(g);
  if (snd.shuffle) {
    // keep the shuffled order of what was already queued, new songs go to the end
    const ids = snd.order.map((j) => map(j)).filter((j) => j >= 0);
    const rest = [...snd.queue.keys()].filter((j) => !ids.includes(j));
    snd.order = ids.concat(rest);
    snd.pos = snd.order.indexOf(at);
  } else {
    snd.order = [...snd.queue.keys()];
    snd.pos = at;
  }
}

function addToPlaylist(p, keys) {
  const room = snd.data.maxPerPlaylist - p.keys.length;
  if (room <= 0) { toast(`楽曲数が${snd.data.maxPerPlaylist}を超えています。`); return false; }
  p.keys.push(...keys.slice(0, room));
  if (keys.length > room) toast(`楽曲数が${snd.data.maxPerPlaylist}を超えています。`);
  savePlaylists();
  remapQueue('p' + p.id, (j) => j);
  renderGroups();
  if (snd.group === 'p' + p.id) renderSongs();
  return true;
}

function removeFromPlaylist(p, i) {
  if (!p) return;
  p.keys.splice(i, 1);
  savePlaylists();
  remapQueue('p' + p.id, (j) => (j === i ? -1 : j > i ? j - 1 : j));
  renderGroups();
  renderSongs();
}

// クイック追加: add every song matching the chosen types and artists (the game's SoundPlayerAddPlayList popup)
async function quickAdd(p) {
  const cats = snd.data.categories.filter((c) => c.quickAdd);
  const pool = snd.data.sounds.filter((t) => cats.some((c) => c.category === t.category));
  const artists = snd.data.artists.filter((a) => pool.some((t) => t.artistId === a.id));
  const wrap = document.createElement('div');
  wrap.className = 's-quick';
  wrap.innerHTML = '<p class="s-quick-desc">条件を指定してプレイリストに楽曲を一括追加します。</p>';
  const section = (title, items) => {
    const head = document.createElement('div');
    head.className = 's-quick-head';
    head.innerHTML = `<span class="tag">${title}</span><i></i>`;
    const all = document.createElement('button');
    all.className = 's-quick-all';
    const grid = document.createElement('div');
    grid.className = 's-quick-grid';
    const toggles = items.map(([value, label]) => {
      const b = document.createElement('button');
      b.className = 's-toggle on';
      b.dataset.value = value;
      b.textContent = label;
      b.addEventListener('click', () => { b.classList.toggle('on'); sync(); });
      grid.appendChild(b);
      return b;
    });
    const sync = () => { all.textContent = toggles.every((b) => !b.classList.contains('on')) ? '全て' : '全て外す'; };
    all.addEventListener('click', () => {
      const on = toggles.every((b) => !b.classList.contains('on'));
      toggles.forEach((b) => b.classList.toggle('on', on));
      sync();
    });
    sync();
    head.appendChild(all);
    wrap.append(head, grid);
    return () => new Set(toggles.filter((b) => b.classList.contains('on')).map((b) => b.dataset.value));
  };
  const pickCats = section('タイプ', cats.map((c) => [c.category, c.name]));
  const pickArtists = section('アーティスト', artists.map((a) => [a.id, a.name]));
  const ok = await popup({ title: 'クイック追加', body: wrap, wide: true, buttons: [{ label: '追加', value: true }, { label: 'キャンセル', value: false, sub: true }] });
  if (!ok) return;
  const cs = pickCats(), as = pickArtists();
  const have = new Set(p.keys);
  const keys = pool.filter((t) => cs.has(t.category) && as.has(t.artistId) && !have.has(t.key))
    .sort((a, b) => cats.findIndex((c) => c.category === a.category) - cats.findIndex((c) => c.category === b.category) || a.order - b.order)
    .map((t) => t.key);
  if (!keys.length) { toast('追加できる楽曲がありません'); return; }
  const room = snd.data.maxPerPlaylist - p.keys.length;
  if (addToPlaylist(p, keys)) toast(`「${p.name}」に${Math.min(keys.length, room)}曲追加しました`);
  if (snd.group !== 'p' + p.id) selectGroup('p' + p.id);
}

// ---------------------------------------------------------------- drag & drop
// drag a song onto a playlist on the left to add it; inside a playlist, drag to reorder
function bindRowDrag(row, t, i) {
  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.s-row-menu')) return;
    const sx = e.clientX, sy = e.clientY;
    let drag = null;
    const sc = document.getElementById('snd');
    const list = document.getElementById('sList');
    const k = sc.getBoundingClientRect().width / 1136;
    const reorder = isPlaylist(snd.group);
    let scrollRaf = null, lastY = sy;
    const autoScroll = () => {
      const r = list.getBoundingClientRect();
      if (lastY < r.top + 40 * k) list.scrollTop -= 8;
      else if (lastY > r.bottom - 40 * k) list.scrollTop += 8;
      scrollRaf = requestAnimationFrame(autoScroll);
    };
    const move = (ev) => {
      lastY = ev.clientY;
      if (!drag) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
        drag = row.cloneNode(true);
        drag.classList.add('s-drag');
        drag.classList.remove('on');
        drag.querySelectorAll('.mq').forEach((m) => { m.style.animation = 'none'; });
        sc.appendChild(drag);
        row.classList.add('dragging');
        if (reorder) scrollRaf = requestAnimationFrame(autoScroll);
      }
      const s = sc.getBoundingClientRect();
      drag.style.left = (ev.clientX - s.left) / k - 169 + 'px';
      drag.style.top = (ev.clientY - s.top) / k - 34 + 'px';
      // drop targets: a playlist node, or a gap between rows of the shown playlist
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      document.querySelectorAll('.s-group.drop').forEach((n) => n.classList.remove('drop'));
      const g = hit && hit.closest('.s-group');
      if (g && isPlaylist(g.dataset.group)) g.classList.add('drop');
      clearMarker();
      if (reorder && hit && hit.closest('#sList')) showMarker(insertIndex(ev.clientY));
    };
    const up = (ev) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (!drag) { player.audio.se(SE_TAP); playFromGroup(snd.group, i); return; }
      drag.remove();
      row.classList.remove('dragging');
      clearMarker();
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      document.querySelectorAll('.s-group.drop').forEach((n) => n.classList.remove('drop'));
      const g = hit && hit.closest('.s-group');
      if (g && isPlaylist(g.dataset.group) && g.dataset.group !== snd.group) {
        const p = playlistOf(g.dataset.group);
        if (p && addToPlaylist(p, [t.key])) toast(`「${p.name}」に追加しました`);
      } else if (reorder && hit && hit.closest('#sList')) {
        moveInPlaylist(playlistOf(snd.group), i, insertIndex(ev.clientY));
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}

function insertIndex(clientY) {
  const rows = [...document.querySelectorAll('#sList .s-row')];
  for (let j = 0; j < rows.length; j++) {
    const r = rows[j].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return j;
  }
  return rows.length;
}
function showMarker(at) {
  const list = document.getElementById('sList');
  const rows = list.querySelectorAll('.s-row');
  const m = document.createElement('div');
  m.className = 's-insert';
  const ref = rows[at] || null;
  m.style.top = (ref ? ref.offsetTop : (rows.length ? rows[rows.length - 1].offsetTop + rows[rows.length - 1].offsetHeight : 0)) - 2 + 'px';
  list.appendChild(m);
}
function clearMarker() { document.querySelectorAll('.s-insert').forEach((m) => m.remove()); }

function moveInPlaylist(p, from, to) {
  if (!p || to === from || to === from + 1) return;
  const [k] = p.keys.splice(from, 1);
  p.keys.splice(to > from ? to - 1 : to, 0, k);
  savePlaylists();
  remapQueue('p' + p.id, (j) => movedIndex(j, from, to));
  renderSongs();
}
function movedIndex(j, from, to) {
  const t = to > from ? to - 1 : to;
  if (j === from) return t;
  if (from < j && j <= t) return j - 1;
  if (t <= j && j < from) return j + 1;
  return j;
}

// ---------------------------------------------------------------- playback
function rebuildOrder(current) {
  const n = snd.queue.length;
  snd.order = [...Array(n).keys()];
  if (snd.shuffle) {
    for (let j = n - 1; j > 0; j--) { const r = Math.floor(Math.random() * (j + 1)); [snd.order[j], snd.order[r]] = [snd.order[r], snd.order[j]]; }
    // the current song stays first so the rest of the list follows it
    if (current >= 0) { snd.order.splice(snd.order.indexOf(current), 1); snd.order.unshift(current); }
  }
  snd.pos = current >= 0 ? snd.order.indexOf(current) : 0;
}

function playFromGroup(g, i) {
  snd.queue = groupSongs(g);
  snd.queueGroup = g;
  rebuildOrder(i);
  startTrack(0);
}

async function startTrack(at) {
  stopTrack();
  const t = snd.queue[snd.order[snd.pos]];
  if (!t) return;
  snd.track = t;
  snd.buf = null;
  snd.offset = at;
  snd.playing = true;
  renderPlayer();
  markPlayingRow();
  updateEqualizer();
  const token = {};
  snd.loadToken = token;
  // whole songs are big (a 2-minute song is ~24 MB of WAV), so only the current one is kept
  const ctx = player.audio.ctx || (player.audio.ensure(), player.audio.ctx);
  const buf = await fetch(audioUrl(t.cue)).then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((b) => (b ? ctx.decodeAudioData(b) : null)).catch(() => null);
  if (snd.loadToken !== token) return;
  if (!buf) { snd.playing = false; renderPlayer(); toast('楽曲を読み込めませんでした'); return; }
  snd.buf = buf;
  if (snd.playing) beginSource(snd.offset);
  renderPlayer();
}

function beginSource(offset) {
  const ctx = player.audio.ctx;
  player.audio.ensure();
  const src = ctx.createBufferSource();
  src.buffer = snd.buf;
  src.connect(player.audio.master.bgm);
  src.onended = () => { if (snd.src === src) { snd.src = null; trackEnded(); } };
  src.start(0, Math.max(0, Math.min(offset, snd.buf.duration)));
  snd.src = src;
  snd.startedAt = ctx.currentTime - offset;
  snd.playing = true;
  startTick();
}

function stopTrack() {
  snd.loadToken = null;
  if (snd.src) { const s = snd.src; snd.src = null; try { s.stop(); } catch (e) { /* already stopped */ } }
  snd.playing = false;
  stopTick();
  updateEqualizer();
}

function position() {
  if (snd.src) return Math.min(player.audio.ctx.currentTime - snd.startedAt, snd.buf.duration);
  return snd.offset;
}
const trackLength = () => (snd.buf ? snd.buf.duration : (snd.track ? snd.track.length : 0));

function togglePlay() {
  if (!snd.track) {
    // nothing chosen yet: start the shown list from the top
    if (groupSongs(snd.group).length) playFromGroup(snd.group, 0);
    return;
  }
  if (snd.playing) {
    snd.offset = position();
    stopTrack();
    renderPlayer();
  } else if (snd.buf) {
    beginSource(snd.offset >= snd.buf.duration - 0.05 ? 0 : snd.offset);
    renderPlayer();
    updateEqualizer();
  } else {
    startTrack(snd.offset);
  }
}

function step(dir) {
  if (!snd.track) return togglePlay();
  // like most players, 戻る restarts the song unless it has only just begun
  if (dir < 0 && position() > 3) return seekTo(0);
  let p = snd.pos + dir;
  if (p < 0) {
    if (snd.repeat !== 'all') return seekTo(0);
    p = snd.order.length - 1;
  } else if (p >= snd.order.length) {
    // past the last song: back to the top (a fresh order when shuffling)
    if (snd.shuffle) rebuildOrder(-1);
    p = 0;
  }
  snd.pos = p;
  startTrack(0);
}

function trackEnded() {
  if (snd.repeat === 'single') return beginSource(0);
  if (snd.pos + 1 < snd.order.length) { snd.pos++; return startTrack(0); }
  if (snd.repeat === 'all') {
    if (snd.shuffle) rebuildOrder(-1);
    snd.pos = 0;
    return startTrack(0);
  }
  // end of the list: stop on the last song, rewound
  snd.playing = false;
  snd.offset = 0;
  stopTick();
  renderPlayer();
  updateEqualizer();
}

function seekTo(sec) {
  if (!snd.track) return;
  const was = snd.playing;
  if (snd.src) { const s = snd.src; snd.src = null; try { s.stop(); } catch (e) { /* stopped */ } }
  snd.offset = Math.max(0, Math.min(sec, trackLength()));
  if (was && snd.buf) beginSource(snd.offset);
  renderTime();
}

function startTick() {
  stopTick();
  const loop = () => { renderTime(); snd.tick = requestAnimationFrame(loop); };
  snd.tick = requestAnimationFrame(loop);
}
function stopTick() { if (snd.tick) cancelAnimationFrame(snd.tick); snd.tick = null; }

// ---------------------------------------------------------------- player (right)
const mmss = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

function renderPlayer() {
  const t = snd.track;
  const jk = document.getElementById('sJacket');
  jk.onerror = () => { jk.onerror = null; jk.src = '/ui/jacket_empty_l.png'; };
  jk.src = t ? asset(t.image) : '/ui/jacket_empty_l.png';
  for (const [id, text] of [['sNow', t ? t.name : ''], ['sArtist', t ? t.artist : '']]) {
    const el = document.getElementById(id);
    el.textContent = text;
    requestAnimationFrame(() => marquee(el));
  }
  document.getElementById('sPlay').classList.toggle('stop', snd.playing);
  document.getElementById('sPlay').setAttribute('aria-label', snd.playing ? '一時停止' : '再生');
  document.getElementById('sShuffle').classList.toggle('on', snd.shuffle);
  const rp = document.getElementById('sRepeat');
  rp.dataset.mode = snd.repeat;
  rp.setAttribute('aria-label', { off: 'リピートなし', all: '全曲リピート', single: '1曲リピート' }[snd.repeat]);
  renderTime();
}

function renderTime() {
  const len = trackLength(), cur = snd.track ? position() : 0;
  document.getElementById('sCur').textContent = mmss(cur);
  document.getElementById('sLen').textContent = mmss(len);
  document.getElementById('sSeek').style.setProperty('--f', len ? Math.min(1, cur / len) : 0);
}

// the playing group's node shows the game's equalizer (13 bars, re-rolled every 0.13 s)
function updateEqualizer() {
  document.querySelectorAll('.s-group').forEach((n) => n.classList.toggle('eq', snd.playing && n.dataset.group === snd.queueGroup));
  clearInterval(snd.eqTimer);
  snd.eqTimer = null;
  if (!snd.playing) return;
  const roll = () => document.querySelectorAll('.s-group.eq .s-eq i').forEach((b) => {
    b.style.transform = `scaleY(${(0.05 + Math.random() * 0.93).toFixed(2)})`;
  });
  roll();
  snd.eqTimer = setInterval(roll, 130);
}

// ---------------------------------------------------------------- ムービー
// the full-screen story movies in reading order under series headings, then the live MVs and the
// game's other videos
const thumbs = new Map();          // movie file -> data URL of a frame
let thumbObserver = null;
const thumbQueue = [];
let thumbBusy = 0;

function renderMovies() {
  const list = document.getElementById('sList');
  if (thumbObserver) thumbObserver.disconnect();
  thumbQueue.length = 0;
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      if (e.target.dataset.img) e.target.style.backgroundImage = `url("${e.target.dataset.img}")`;
      else { thumbQueue.push(e.target); nextThumb(); }
    }
  }, { root: list, rootMargin: '300px 0px' });
  let series = null;
  snd.movies.forEach((m) => {
    const sec = m.series || 'その他';
    if (sec !== series) {
      series = sec;
      const h = document.createElement('div');
      h.className = 's-section';
      h.textContent = sec;
      list.appendChild(h);
    }
    list.appendChild(movieRow(m));
  });
}

// story movies are MP4s; the USM ones (live MVs, PV, tutorial) are remuxed to MP4 by the server
const movieSrc = (m) => (m.usm ? '/usm/' + encodeURIComponent(m.file) + '.mp4' : asset(m.file));

// the sound player track a movie's music is, if it is one
function movieTrack(m) {
  const cue = (m.bgmInfo[0] && m.bgmInfo[0].cue) || m.bgm;
  return cue ? snd.data.sounds.find((x) => x.cue === cue) || null : null;
}
// what the movie's music is, named like the sound player's tracks where it is one of them
function movieMusic(m) {
  const cue = (m.bgmInfo[0] && m.bgmInfo[0].cue) || m.bgm;
  if (!cue || cue.startsWith('usm:')) return '';
  const t = movieTrack(m);
  return t ? t.name : cue;
}

function movieRow(m) {
  const row = document.createElement('div');
  row.className = 's-row s-movie';
  row.title = m.file;
  const th = document.createElement('div');
  th.className = 's-row-jacket s-thumb';
  th.dataset.file = m.file;
  th.dataset.src = movieSrc(m);
  th.dataset.at = Math.min(8, (m.duration || 0) * 0.4);
  // a live MV shows its song's jacket (cheaper than building the video for one frame)
  const jacket = m.category === 'mv' && movieTrack(m);
  if (jacket) th.dataset.img = asset(jacket.image);
  if (!jacket && thumbs.has(m.file)) th.style.backgroundImage = `url("${thumbs.get(m.file)}")`;
  else thumbObserver.observe(th);
  const badge = document.createElement('span');
  badge.className = 's-badge';
  badge.textContent = mmss(m.duration);
  th.appendChild(badge);
  const name = document.createElement('div');
  name.className = 's-row-name';
  name.textContent = m.uses.length || m.usm ? [m.title, m.subtitle].filter(Boolean).join(' ') : m.file;
  const line = document.createElement('i');
  line.className = 's-row-line';
  const info = document.createElement('div');
  info.className = 's-row-artist';
  const music = movieMusic(m);
  const parts = [m.category === 'mv' ? 'MV' : 'ムービー'];
  if (m.voice) parts.push('ボイス');
  if (music) parts.push('♪' + music);
  else if (m.loopSe) parts.push('環境音');
  else if (m.own_audio) parts.push('音声つき');
  // the -5th Anniv. Live ver.- MVs: their audio was never in the game's data
  else if (m.category === 'mv') parts.push('音声なし');
  info.textContent = parts.join('　');
  row.append(th, name, line, info);
  if (m.uses.length) {
    const opt = document.createElement('button');
    opt.className = 's-row-menu';
    opt.setAttribute('aria-label', '使用エピソード');
    opt.addEventListener('click', (e) => { e.stopPropagation(); movieMenu(m, row); });
    row.appendChild(opt);
  }
  row.addEventListener('click', () => { player.audio.se(SE_TAP); playMovie(m); });
  queueMarquee(name, info);
  return row;
}

// a frame from each movie, grabbed in the browser a few at a time and kept as a small image
function nextThumb() {
  while (thumbBusy < 3 && thumbQueue.length) {
    const th = thumbQueue.shift();
    if (!th.isConnected) continue;
    thumbBusy++;
    grabFrame(th.dataset.src, Number(th.dataset.at)).then((url) => {
      thumbBusy--;
      if (url) { thumbs.set(th.dataset.file, url); th.style.backgroundImage = `url("${url}")`; }
      nextThumb();
    });
  }
}
function grabFrame(src, at) {
  return new Promise((res) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    const done = (url) => { v.removeAttribute('src'); v.load(); res(url); };
    const timer = setTimeout(() => done(null), 15000);
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(at, Math.max(0, v.duration - 0.1)); }, { once: true });
    v.addEventListener('seeked', () => {
      clearTimeout(timer);
      const c = document.createElement('canvas');
      c.width = c.height = 100;
      const side = Math.min(v.videoWidth, v.videoHeight);
      try {
        c.getContext('2d').drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, 100, 100);
        done(c.toDataURL('image/jpeg', 0.8));
      } catch (e) { done(null); }
    }, { once: true });
    v.addEventListener('error', () => { clearTimeout(timer); done(null); }, { once: true });
    v.src = src;
  });
}

// ••• on a movie: the episodes it appears in; picking one opens the story at that page
function movieMenu(m, row) {
  const pop = document.createElement('div');
  pop.className = 's-sub-uses';
  pop.innerHTML = '<div class="s-sub-head">使用エピソード</div>';
  const uses = m.uses.slice(0, 4);
  uses.forEach((u, i) => {
    const s = T.byId.get(u.scenario);
    if (!s) return;
    const b = document.createElement('button');
    b.className = 's-sub-btn white use';
    b.style.top = 56 + i * 68 + 'px';
    b.textContent = [s.title, s.subtitle].filter(Boolean).join(' ');
    b.addEventListener('click', () => openUse(s, u.page));
    pop.appendChild(b);
  });
  openSubMenu(row, pop, 588, 72 + uses.length * 68);
}
function openUse(s, page) {
  closeSubMenu();
  stopTrack();
  snd.track = null;
  snd.buf = null;
  document.getElementById('snd').hidden = true;
  playScenario(s, { startPage: page });
}

// full screen, like a full-screen movie in a story: tap for SKIP / pause / seek
const mvx = { ui: null, movie: null, live: [], stop: null };

function playMovie(m) {
  // the song pauses while a movie plays
  if (snd.playing) { snd.offset = position(); stopTrack(); renderPlayer(); }
  const sec = document.getElementById('mvx');
  const v = document.getElementById('mvxVideo');
  if (!mvx.ui) {
    mvx.ui = movieControls(document.getElementById('mvxui'), v, closeMovie);
    sec.addEventListener('click', () => mvx.ui.toggle());
    sec.addEventListener('contextmenu', (e) => { e.preventDefault(); closeMovie(); });
  }
  mvx.movie = m;
  // voice and music cues follow the video's clock (as in stories); the page's BGM / looping SE just plays
  const tracks = [];
  if (m.voice) tracks.push({ cue: m.voice, kind: 'voice', at: 0 });
  for (const b of m.bgmInfo) tracks.push({ cue: b.cue, kind: 'bgm', at: b.at });
  const stopTracks = () => { for (const h of mvx.live) { try { h.src.stop(); } catch (e) { /* stopped */ } } mvx.live = []; };
  const sync = async () => {
    stopTracks();
    if (v.paused || v.ended || !tracks.length) return;
    const t = v.currentTime;
    const mine = mvx.live;
    const started = await Promise.all(tracks.map((tr) => player.audio.playFrom(tr.cue, tr.kind, Math.max(0, t - tr.at), Math.max(0, tr.at - t))));
    if (mvx.live !== mine || v.paused) { for (const h of started) if (h) h.src.stop(); return; }
    mvx.live = started.filter(Boolean);
  };
  const ambient = (on) => {
    player.audio.setBgm(on ? m.bgm : null);
    player.audio.setLoopSe(on ? m.loopSe : null);
  };
  v.onplaying = () => { sync(); ambient(true); };
  v.onseeked = sync;
  v.onpause = () => { stopTracks(); ambient(false); };
  v.onended = closeMovie;
  v.onerror = () => { toast('ムービーを再生できませんでした'); closeMovie(); };
  mvx.stop = () => { stopTracks(); ambient(false); };
  v.loop = false;
  // the game's own videos carry their sound inside; it follows the BGM volume. Story movies play muted, as in the game
  // (its VideoPlayer has no audio output): their sound is the cues above, though some MP4s carry an audio track too
  v.volume = m.own_audio ? Math.min(1, settings.bgm / 100) : 1;
  v.muted = !m.own_audio;
  v.src = movieSrc(m);
  sec.hidden = false;
  // only a refusal to autoplay with sound falls back to muted (an interrupted play() is not one)
  v.play().catch((e) => { if (e.name === 'NotAllowedError') { v.muted = true; v.play().catch(() => {}); } });
  mvx.ui.show();
}

function closeMovie() {
  const sec = document.getElementById('mvx');
  if (sec.hidden) return;
  const v = document.getElementById('mvxVideo');
  v.onplaying = v.onseeked = v.onpause = v.onended = v.onerror = null;
  v.pause();
  if (mvx.stop) mvx.stop();
  v.removeAttribute('src');
  v.load();
  mvx.ui.hide();
  sec.hidden = true;
  mvx.movie = null;
}

// keys over a movie (called from app.js): Space / Enter / → show the controls, Esc / Backspace / ← close it
function movieKey(e) {
  if ([' ', 'Enter', 'ArrowRight'].includes(e.key)) { e.preventDefault(); mvx.ui.toggle(); }
  else if (['Escape', 'Backspace', 'ArrowLeft'].includes(e.key)) { e.preventDefault(); player.audio.se(SE_CANCEL); closeMovie(); }
}

// ---------------------------------------------------------------- input
function bindSound() {
  const on = (id, fn) => document.getElementById(id).addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  on('sBack', closeSound);
  on('sHome', closeSound);
  on('sPlay', togglePlay);
  on('sPrev', () => step(-1));
  on('sNext', () => step(1));
  on('sShuffle', () => {
    snd.shuffle = !snd.shuffle;
    store.set('sndShuffle', snd.shuffle);
    if (snd.queue.length) rebuildOrder(snd.order[snd.pos]);
    renderPlayer();
  });
  on('sRepeat', () => {
    snd.repeat = SND_REPEAT[(SND_REPEAT.indexOf(snd.repeat) + 1) % SND_REPEAT.length];
    store.set('sndRepeat', snd.repeat);
    renderPlayer();
  });
  const bar = document.getElementById('sSeek');
  const seek = (e) => {
    const r = bar.getBoundingClientRect();
    // the knob travels between 10px insets, like the game's Handle Slide Area
    const k = r.width / 238;
    const f = Math.min(1, Math.max(0, (e.clientX - r.left - 10 * k) / (r.width - 20 * k)));
    seekTo(f * trackLength());
  };
  bar.addEventListener('pointerdown', (e) => {
    if (!snd.track) return;
    bar.setPointerCapture(e.pointerId);
    seek(e);
    const move = (ev) => seek(ev);
    const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  });
}

// keys while the sound player is shown (called from app.js): Space play/pause, ←/→ previous/next,
// Esc / Backspace close a sub menu, otherwise leave
function soundKey(e) {
  const typing = e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
  if (typing) { if (e.key === 'Escape') { e.preventDefault(); closeSubMenu(); } return; }
  switch (e.key) {
    case 'Escape': case 'Backspace':
      e.preventDefault();
      if (!closeSubMenu()) { player.audio.se(SE_CANCEL); closeSound(); }
      break;
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); step(-1); break;
    case 'ArrowRight': e.preventDefault(); step(1); break;
    default:
  }
}
