"""Local story viewer server for an archived Tokyo 7th Sisters install.

Reads the user's own archived files, decrypts on the fly, and serves a browser UI.
usage: python scripts/server.py   (then open http://127.0.0.1:7777)
"""
import collections
import hashlib
import io
import json
import mimetypes
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import urllib.parse
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import config
import t7scrypt
import usm
from check_refs import clean_cue

WEB_DIR = os.path.join(config.ROOT, 'web')


def load_json(name, default):
    path = os.path.join(config.DATA_DIR, name)
    if not os.path.exists(path):
        return default
    with open(path, encoding='utf-8') as f:
        return json.load(f)


class Data:
    def __init__(self):
        self.reload()

    def reload(self):
        self.assets = load_json('assets.json', {})
        self.cues = load_json('cues.json', {})
        self.facepos = load_json('facepos.json', {})
        self.completeness = load_json('completeness.json', {})
        self._tree = None
        self._sounds = None
        self._movies = None

    def asset_path(self, name):
        """Resolve a script/table reference (with or without .enc / extension) to a file on disk."""
        # some table entries carry invisible bidi marks or a '.ene' typo
        name = re.sub('[​-‏⁦-⁩﻿]', '', name).strip()
        if name.endswith('.ene'):
            name = name[:-1] + 'c'
        for cand in (name, name + '.enc', name + '.png.enc', name + '.jpg.enc'):
            real = self.assets.get(cand)
            if real:
                return os.path.join(config.DOWNLOAD_DIR, real)
        # story videos are stored as <SHA1 of the file name>.acb (they are plain MP4s)
        if name.endswith('.mp4'):
            real = self.assets.get(hashlib.sha1(name.encode('utf-8')).hexdigest().upper() + '.acb')
            if real:
                return os.path.join(config.DOWNLOAD_DIR, real)
        return None

    def tree(self):
        if self._tree is None:
            db = sqlite3.connect(config.MASTER_DB)
            db.row_factory = sqlite3.Row
            layers = [dict(r) for r in db.execute(
                'SELECT layer_id, parent_id, category, title, subtitle, priority, img_path, btn_img_path, '
                'bg_img_path, character_img_path FROM m_scenario_layer')]
            scenarios = []
            characters = {r[0]: r[1] for r in db.execute('SELECT character_id, character_name FROM m_character')}
            for r in db.execute('SELECT scenario_id, category, parent_layer_id, title, subtitle, priority, img_path, '
                                'txt_path, estimated_reading_time, main_character_ids_string, sub_character_ids_string '
                                'FROM m_scenario'):
                s = dict(r)
                s['available'] = self.asset_path(s['txt_path']) is not None
                c = self.completeness.get(s['scenario_id'])
                if c:
                    s['assets'], s['missing'] = c['assets'], c['missing']
                scenarios.append(s)
            db.close()
            self._tree = {'layers': layers, 'scenarios': scenarios, 'characters': characters}
        return self._tree

    def sounds(self):
        """サウンドプレイヤー: categories, tracks and artists from the game tables, plus its playlist limits."""
        if self._sounds is None:
            db = sqlite3.connect(config.MASTER_DB)
            db.row_factory = sqlite3.Row
            num = lambda v: int(v) if str(v).lstrip('-').isdigit() else 0
            cats = [{'category': r['category'], 'name': r['category_name'], 'order': num(r['order']),
                     'quickAdd': r['show_in_play_list_popup'] == '1'}
                    for r in db.execute('SELECT * FROM m_sound_player_category')]
            cats.sort(key=lambda c: c['order'])
            sounds = []
            for r in db.execute('SELECT * FROM m_sound_player'):
                # ids repeat across categories (ボーカル 1 and インスト 1 are different tracks), so key on both
                sounds.append({'key': r['category'] + ':' + r['id'], 'id': r['id'], 'category': r['category'], 'name': r['sound_name'],
                               'artist': r['artist_name'], 'artistId': r['artist_id'], 'order': num(r['order']),
                               'length': num(r['length']), 'image': r['image'], 'cue': r['acb'],
                               'available': r['acb'] in self.cues})
            sounds.sort(key=lambda t: (t['order'], num(t['id'])))
            # artist filter of クイック追加: the live artists, named as the game's artist table has them
            named = {r['artist_id']: (num(r['sort_id']), r['artist_name']) for r in db.execute('SELECT * FROM m_live_artist')}
            artists = {}
            for t in sounds:
                if t['artistId'] not in artists:
                    sort, name = named.get(t['artistId'], (num(t['artistId']), t['artist']))
                    artists[t['artistId']] = {'id': t['artistId'], 'name': name, 'sort': sort}
            limits = {r['id']: num(r['value']) for r in db.execute("SELECT id, value FROM m_system_config WHERE id IN ('30', '31')")}
            db.close()
            self._sounds = {'categories': cats, 'sounds': sounds,
                            'artists': sorted(artists.values(), key=lambda a: (a['sort'], num(a['id']))),
                            # ConfigDefinition SoundPlayerMaxPlayListCount = 30, SoundPlayerMaxSoundCountInPlayList = 31
                            'maxPlaylists': limits.get('30') or 10, 'maxPerPlaylist': limits.get('31') or 300}
        return self._sounds

    def movies(self):
        """サウンドプレイヤー's ムービー list: data/movies.json (built by build_index.py) plus each movie's series."""
        if self._movies is None:
            movies = load_json('movies.json', [])
            tree = self.tree()
            layers = {(l['category'], l['layer_id']): l for l in tree['layers']}
            by_id = {s['scenario_id']: s for s in tree['scenarios']}
            for m in movies:
                if not m['uses']:
                    m.setdefault('series', '')
                    continue
                s = by_id.get(m['uses'][0]['scenario'])
                names, lid, seen = [], s and s['parent_layer_id'], set()
                while s and (s['category'], lid) in layers and lid not in seen:
                    seen.add(lid)
                    l = layers[(s['category'], lid)]
                    names.insert(0, l['title'] or '')
                    lid = l['parent_id']
                # drop the year level (2034年 / 2053年) and keep the series
                names = [n for n in names if n and not re.fullmatch(r'\d{4}年', n)]
                m['series'] = names[0] if names else ''
            self._movies = movies
        return self._movies

    def scenario(self, sid):
        for s in self.tree()['scenarios']:
            if s['scenario_id'] == sid:
                return s
        return None


DATA = Data()

_bank_cues = {}


def bank_cue(acb, name):
    """Find a cue inside a specific bank (cue names repeat across banks, e.g. se_001)."""
    if acb not in _bank_cues:
        out = subprocess.run([config.VGMSTREAM, '-m', '-I', '-S', '0', os.path.join(config.DOWNLOAD_DIR, acb)],
                             capture_output=True, text=True, encoding='utf-8', errors='replace').stdout
        table = {}
        for line in out.splitlines():
            if line.strip().startswith('{'):
                info = json.loads(line).get('streamInfo') or {}
                for nm in (info.get('name') or '').split(';'):
                    table.setdefault(nm.strip(), info.get('index'))
        _bank_cues[acb] = table
    idx = _bank_cues[acb].get(name)
    return [acb, idx] if idx else None


def resolve_cue(cue):
    """`cue` is a cue name, or `<bank.acb>@<cue>` to pick it from a specific bank -> (acb, subsong)."""
    if '@' in cue:
        acb, name = cue.split('@', 1)
        return bank_cue(os.path.basename(acb), name) if acb in DATA.assets else None
    return DATA.cues.get(cue)


def pin_voice_bank(script, txt_path):
    """Clean up typo'd voice names, then point voice cues at the script's own bank (ing3_101008_01.json ->
    ing3_101008.acb).

    Some episodes reuse another episode's cue names with different recordings (3.0-008 and 3.0-006 both
    use vo_ing3_050_*), and cues.json keeps only the first bank per name, so prefer the script's own bank.
    """
    for page in script.get('Pages') or []:
        sound = page.get('Sound') or {}
        if sound.get('VoiceFileName'):
            sound['VoiceFileName'] = clean_cue(sound['VoiceFileName'])
    own = re.sub(r'_\d+\.json(\.enc)?$', '.acb', txt_path)
    if own == txt_path or own not in DATA.assets:
        return
    for page in script.get('Pages') or []:
        sound = page.get('Sound') or {}
        cue = sound.get('VoiceFileName')
        hit = cue and '@' not in cue and DATA.cues.get(cue)
        if hit and hit[0] != own and bank_cue(own, cue):
            sound['VoiceFileName'] = own + '@' + cue


# Audio is decoded on demand straight from the original .acb (≈50 ms for a voice line, ≈160 ms for a
# full BGM track), so nothing is written to disk; the browser keeps recently played sounds in memory.
_loop_info = {}


def cue_loop(acb, sub):
    """Loop points (seconds) of a subsong, or None; small, so remembered in memory."""
    key = (acb, sub)
    if key not in _loop_info:
        info = subprocess.run([config.VGMSTREAM, '-m', '-I', '-s', str(sub), os.path.join(config.DOWNLOAD_DIR, acb)],
                              capture_output=True, text=True, encoding='utf-8', errors='replace').stdout
        loop = None
        for line in info.splitlines():
            if line.strip().startswith('{'):
                j = json.loads(line)
                li = j.get('loopingInfo')
                if li:
                    loop = {'start': li['start'] / j['sampleRate'], 'end': li['end'] / j['sampleRate']}
                break
        _loop_info[key] = loop
    return _loop_info[key]


def decode_cue(acb, sub):
    """Decode one subsong to WAV bytes (played once through, loops removed)."""
    return subprocess.run([config.VGMSTREAM, '-p', '-i', '-s', str(sub), os.path.join(config.DOWNLOAD_DIR, acb)],
                          capture_output=True, check=True).stdout


_usm_cache = collections.OrderedDict()   # a few remuxed movies, so seeking doesn't rebuild them


_usm_lock = threading.Lock()   # the browser asks for several ranges at once; build each movie once


def usm_mp4(real):
    with _usm_lock:
        if real not in _usm_cache:
            with open(os.path.join(config.DOWNLOAD_DIR, real), 'rb') as f:
                _usm_cache[real] = usm.to_mp4(f.read())
            while len(_usm_cache) > 3:
                _usm_cache.popitem(last=False)
        _usm_cache.move_to_end(real)
        return _usm_cache[real]


def decode_usm_audio(name):
    """WAV of a USM's own audio track. vgmstream reads it from the USM itself but wants a .usm name, so
    it gets a temporary link (or copy) of the file."""
    real = DATA.assets.get(os.path.basename(name))
    if not real:
        return None
    src = os.path.join(config.DOWNLOAD_DIR, real)
    with tempfile.TemporaryDirectory() as tmp:
        link = os.path.join(tmp, 'movie.usm')
        try:
            os.link(src, link)
        except OSError:
            shutil.copyfile(src, link)
        out = subprocess.run([config.VGMSTREAM, '-p', '-i', link], capture_output=True).stdout
    return out or None


def sniff_type(data, name):
    if data[:4] == b'\x89PNG':
        return 'image/png'
    if data[:3] == b'\xff\xd8\xff':
        return 'image/jpeg'
    if data[4:8] == b'ftyp':
        return 'video/mp4'
    if data[:1] in (b'{', b'['):
        return 'application/json'
    return mimetypes.guess_type(name.replace('.enc', ''))[0] or 'application/octet-stream'


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB_DIR, **kw)

    def end_headers(self):
        # the viewer's own page/code files must never be served stale after an update
        if not self.path.startswith(('/asset/', '/audio/', '/font/', '/ui/', '/api/')):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '--verbose' in sys.argv:
            super().log_message(fmt, *args)

    def send_bytes(self, data, ctype, cache=True):
        self.send_response(HTTPStatus.OK)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'max-age=86400' if cache else 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, obj, cache=False):
        self.send_bytes(json.dumps(obj, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8', cache)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(url.path)
        try:
            if path == '/api/tree':
                return self.send_json(DATA.tree())
            if path == '/api/movies':
                return self.send_json(DATA.movies())
            if path == '/api/sounds':
                return self.send_json(DATA.sounds())
            if path == '/api/facepos':
                return self.send_json(DATA.facepos, cache=True)
            if path.startswith('/font/'):
                return self.serve_font(path[len('/font/'):])
            if path.startswith('/ui/'):
                return self.serve_ui(path[len('/ui/'):])
            if path.startswith('/api/script/'):
                return self.serve_script(path[len('/api/script/'):])
            if path.startswith('/asset/'):
                return self.serve_asset(path[len('/asset/'):])
            if path.startswith('/usm/'):
                return self.serve_usm(path[len('/usm/'):])
            if path.startswith('/audio/'):
                return self.serve_audio(path[len('/audio/'):])
            if path == '/api/reload':
                DATA.reload()
                return self.send_json({'ok': True})
        except ConnectionError:   # the browser dropped the request (e.g. seeking or closing a video)
            return
        except Exception as e:  # report instead of dropping the connection (status line must be ASCII)
            return self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, repr(e)[:200].encode('ascii', 'backslashreplace').decode())
        return super().do_GET()

    def serve_script(self, sid):
        s = DATA.scenario(sid)
        if not s:
            return self.send_error(HTTPStatus.NOT_FOUND, 'unknown scenario')
        p = DATA.asset_path(s['txt_path'])
        if not p:
            return self.send_error(HTTPStatus.NOT_FOUND, 'script not downloaded')
        script = json.loads(t7scrypt.decode_path(p))
        pin_voice_bank(script, s['txt_path'])
        self.send_json({'meta': s, 'script': script})

    def serve_asset(self, name):
        p = DATA.asset_path(name)
        if not p:
            return self.send_error(HTTPStatus.NOT_FOUND, 'asset not downloaded')
        if name.endswith('.mp4'):
            return self.serve_file_range(p, 'video/mp4')
        with open(p, 'rb') as f:
            raw = f.read()
        data = t7scrypt.decode_file(raw) if name.endswith('.enc') or p.endswith('.enc') else raw
        self.send_bytes(data, sniff_type(data, name))

    def serve_file_range(self, path, ctype):
        """Serve a file with HTTP Range support so the browser can stream and loop video."""
        with open(path, 'rb') as f:
            self.serve_range(f, os.path.getsize(path), ctype)

    def serve_range(self, f, size, ctype):
        start, end = 0, size - 1
        m = re.match(r'bytes=(\d*)-(\d*)', self.headers.get('Range', ''))
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        else:
            self.send_response(HTTPStatus.OK)
        self.send_header('Content-Type', ctype)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Cache-Control', 'max-age=86400')
        self.end_headers()
        f.seek(start)
        left = end - start + 1
        while left > 0:
            chunk = f.read(min(1 << 20, left))
            if not chunk:
                break
            self.wfile.write(chunk)
            left -= len(chunk)

    def serve_usm(self, name):
        """A CRI USM movie (live MVs etc.) as MP4, unmasked and remuxed in memory (see usm.py)."""
        name = os.path.basename(name)
        if name.endswith('.mp4'):
            name = name[:-4]
        real = DATA.assets.get(name)
        if not real:
            return self.send_error(HTTPStatus.NOT_FOUND, 'movie not downloaded')
        data = usm_mp4(real)
        self.serve_range(io.BytesIO(data), len(data), 'video/mp4')

    def serve_font(self, name):
        # fonts are extracted from the user's own APK by build_index.py
        path = os.path.join(config.DATA_DIR, 'fonts', os.path.basename(name))
        if not os.path.exists(path):
            return self.send_error(HTTPStatus.NOT_FOUND, 'font not extracted')
        with open(path, 'rb') as f:
            self.send_bytes(f.read(), 'font/otf')

    def serve_ui(self, name):
        # the game's UI sprites, exported from the APK by extract_ui.py
        path = os.path.join(config.DATA_DIR, 'ui', os.path.basename(name))
        if not os.path.exists(path):
            return self.send_error(HTTPStatus.NOT_FOUND, 'ui sprite missing')
        with open(path, 'rb') as f:
            self.send_bytes(f.read(), 'image/png')

    def serve_audio(self, rest):
        is_meta = rest.endswith('.json')
        cue = rest[:-5] if is_meta else (rest[:-4] if rest.endswith('.wav') else rest)
        if cue.startswith('usm:'):
            if is_meta:
                return self.send_json({'loop': None}, cache=True)
            wav = decode_usm_audio(cue[4:])
            if wav is None:
                return self.send_error(HTTPStatus.NOT_FOUND, 'no audio in movie')
            return self.send_bytes(wav, 'audio/wav')
        entry = resolve_cue(cue)
        if not entry:
            return self.send_error(HTTPStatus.NOT_FOUND, 'cue not found')
        if is_meta:
            return self.send_json({'loop': cue_loop(*entry)}, cache=True)
        self.send_bytes(decode_cue(*entry), 'audio/wav')


def main():
    missing = [n for n in ('assets.json', 'cues.json', 'facepos.json', 'master.sqlite')
               if not os.path.exists(os.path.join(config.DATA_DIR, n))]
    if missing:
        sys.exit('Missing %s - run "python sync.py --no-pull" first.' % ', '.join(missing))
    config.ensure_hcakey()
    srv = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    if config.HOST == '127.0.0.1':
        # "localhost" tries IPv6 (::1) first on Windows; without a listener there every new connection
        # waits ~200 ms before falling back to 127.0.0.1, so answer on the IPv6 loopback too (still local only)
        try:
            srv6 = type('Server6', (ThreadingHTTPServer,), {'address_family': socket.AF_INET6})(('::1', config.PORT), Handler)
            threading.Thread(target=srv6.serve_forever, daemon=True).start()
        except OSError:
            pass
    print('Story viewer running at http://%s:%d  (Ctrl+C to stop)' % (config.HOST, config.PORT))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
