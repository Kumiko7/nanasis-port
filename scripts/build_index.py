"""Build lookup indexes the viewer needs from the archived game data.

  data/assets.json  base name (hash stripped) -> actual file name in download/
  data/cues.json    audio cue name -> [acb file, subsong index]
  data/facepos.json body key (CCC_OO) -> [x, y] top-left of the face patch on the body image
  data/movies.json  every story movie with its sound and first use (サウンドプレイヤー's ムービー list)

usage: python scripts/build_index.py
"""
import json
import os
import hashlib
import re
import sqlite3
import struct
import subprocess
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor

import config
import t7scrypt
import usm

HASH_RE = re.compile(r'_[0-9A-F]{64}(?=\.)')


def base_name(name):
    return HASH_RE.sub('', name)


def build_assets():
    assets = {}
    for name in os.listdir(config.DOWNLOAD_DIR):
        # (dotfiles are the viewer's own, e.g. vgmstream's .hcakey)
        if not name.startswith('.') and os.path.isfile(os.path.join(config.DOWNLOAD_DIR, name)):
            assets[base_name(name)] = name
    return assets


def list_cues(acb):
    out = subprocess.run([config.VGMSTREAM, '-m', '-I', '-S', '0', os.path.join(config.DOWNLOAD_DIR, acb)],
                         capture_output=True, text=True, encoding='utf-8', errors='replace').stdout
    cues = []
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            info = json.loads(line)['streamInfo']
        except (ValueError, KeyError, TypeError):
            continue
        if info and info.get('name'):
            # a subsong may carry several cue names separated by "; "
            for nm in info['name'].split(';'):
                cues.append((nm.strip(), info['index']))
    return acb, cues


def build_cues(assets):
    acbs = sorted(v for k, v in assets.items() if k.endswith('.acb'))
    cues = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for n, (acb, found) in enumerate(pool.map(list_cues, acbs), 1):
            for name, idx in found:
                cues.setdefault(name, [acb, idx])
            if n % 200 == 0:
                print('  scanned %d/%d banks' % (n, len(acbs)))
    return cues


def build_facepos(assets):
    pos = {}
    builtin = os.path.join(config.BUILTIN_DIR, 'builtInCharaFacePosition.txt')
    if not os.path.exists(builtin):  # first-time setup from the APK
        os.makedirs(config.BUILTIN_DIR, exist_ok=True)
        with open(builtin, 'wb') as f:
            f.write(zipfile.ZipFile(config.BASE_APK).read('assets/builtInCharaFacePosition.txt'))
    sources = [open(builtin, 'rb').read()]
    if 'characterFacePosition.txt.enc' in assets:
        sources.append(t7scrypt.decode_path(os.path.join(config.DOWNLOAD_DIR, assets['characterFacePosition.txt.enc'])))
    for raw in sources:  # downloaded file overrides the built-in one
        for line in raw.decode('utf-8-sig').splitlines():
            parts = line.strip().split(',')
            if len(parts) == 3:
                pos[parts[0]] = [float(parts[1]), float(parts[2])]
    return pos


# dialogue, titles, and the movie player's time display (FOT-Zerksie, which lives in its own UI bundle)
FONTS = {'RodinNTLGPro-DB': 'rodin.otf', 'KafuTechnoStd-E': 'kafu.otf', 'FOTZerksie': 'zerksie.otf'}


def _font_info(blob, off):
    """Return (length, full name) of an OpenType font starting at off, or None."""
    try:
        num = struct.unpack_from('>H', blob, off + 4)[0]
        if not 4 <= num <= 40:
            return None
        tables = {}
        for i in range(num):
            tag, _, toff, tlen = struct.unpack_from('>4sIII', blob, off + 12 + 16 * i)
            tables[tag] = (toff, tlen)
        if b'cmap' not in tables or b'name' not in tables:
            return None
        end = max(o + l for o, l in tables.values())
        noff = off + tables[b'name'][0]
        count, soff = struct.unpack_from('>HH', blob, noff + 2)
        for i in range(count):
            pid, _, _, nid, ln, so = struct.unpack_from('>6H', blob, noff + 6 + 12 * i)
            if nid == 4 and pid == 3:
                return end, blob[noff + soff + so:noff + soff + so + ln].decode('utf-16-be')
        return end, None
    except (struct.error, UnicodeDecodeError):
        return None


def build_fonts():
    """Pull the game's dialogue and title fonts out of the APK's Unity data (for local use only)."""
    out_dir = os.path.join(config.DATA_DIR, 'fonts')
    if all(os.path.exists(os.path.join(out_dir, f)) for f in FONTS.values()):
        return
    os.makedirs(out_dir, exist_ok=True)
    z = zipfile.ZipFile(config.BASE_APK)
    splits = sorted((n for n in z.namelist() if n.startswith('assets/bin/Data/sharedassets0.assets.split')),
                    key=lambda n: int(n.rsplit('split', 1)[1]))
    blobs = [b''.join(z.read(n) for n in splits)]
    # the smaller fonts sit in the hash-named bundles next to it
    blobs += (z.read(n) for n in z.namelist()
              if re.fullmatch(r'assets/bin/Data/[0-9a-f]{32}', n) and z.getinfo(n).file_size < 4 << 20)
    for blob in blobs:
        for m in re.finditer(rb'OTTO\x00[\x04-\x28]', blob):
            info = _font_info(blob, m.start())
            if info and info[1] in FONTS and not os.path.exists(os.path.join(out_dir, FONTS[info[1]])):
                with open(os.path.join(out_dir, FONTS[info[1]]), 'wb') as f:
                    f.write(blob[m.start():m.start() + info[0]])
                print('font:', info[1])


def mp4_duration(path):
    """Length in seconds from an MP4's mvhd box (None if it can't be read)."""
    with open(path, 'rb') as f:
        data = f.read()
    i = data.find(b'mvhd')
    if i < 0:
        return None
    ver = data[i + 4]
    if ver == 1:
        scale, dur = struct.unpack('>IQ', data[i + 24:i + 36])
    else:
        scale, dur = struct.unpack('>II', data[i + 16:i + 24])
    return round(dur / scale, 2) if scale else None


# videos outside the stories (their sound is inside the file)
OTHER_MOVIES = ['movie.mp4', 'live_tutorial.mp4', 'live_tutorial_2lane.mp4']


def usm_movies(assets, db):
    """The CRI USM videos: M<music id>.enc is a live's background video (its music is the live's song cue,
    starting with the video), music_pv.enc a song PV and furifurimode_tutorial.enc a gameplay tutorial
    (both with their own audio, served as cue 'usm:<file>')."""
    lives = {r[0]: r for r in db.execute('SELECT music_id, music_name, acb, artist_id FROM m_live_music')}
    artists = {r[0]: r[1] for r in db.execute('SELECT artist_id, artist_name FROM m_live_artist')}
    cues = json.load(open(os.path.join(config.DATA_DIR, 'cues.json'), encoding='utf-8')) \
        if os.path.exists(os.path.join(config.DATA_DIR, 'cues.json')) else {}
    out = []

    def entry(name, real, title, subtitle, series, cue, own):
        with open(os.path.join(config.DOWNLOAD_DIR, real), 'rb') as f:
            info = usm.video_info(f.read(1 << 20))
        dur = round(info['total_frames'] * info['framerate_d'] / info['framerate_n'], 2) if info else None
        return {'file': name, 'usm': True, 'category': 'mv' if series else 'other', 'title': title,
                'subtitle': subtitle, 'series': series, 'loop': False, 'full': True, 'voice': None,
                'bgmInfo': [{'cue': cue, 'at': 0}] if cue else [], 'bgm': None, 'loopSe': None,
                'own_audio': own, 'duration': dur, 'available': True, 'uses': []}
    mvs = sorted((n for n in assets if re.fullmatch(r'M\d+\.enc', n)), key=lambda n: int(n[1:-4]))
    for name in mvs:
        live = lives.get(str(int(name[1:-4])))
        if not live:
            continue
        # the -5th Anniv. Live ver.- videos' audio (LiveCut_*) was never in the game's data
        cue = live[2] if live[2] in cues else None
        out.append(entry(name, assets[name], live[1], artists.get(live[3], ''), 'ライブMV', cue, False))
    if 'music_pv.enc' in assets:
        # its stream is named M138_PV_game: a PV of live song 138
        live = lives.get('138')
        out.append(entry('music_pv.enc', assets['music_pv.enc'], (live[1] + ' PV') if live else 'music_pv',
                         '', '', 'usm:music_pv.enc', True))
    if 'furifurimode_tutorial.enc' in assets:
        out.append(entry('furifurimode_tutorial.enc', assets['furifurimode_tutorial.enc'], 'フリフリモード チュートリアル',
                         '', '', 'usm:furifurimode_tutorial.enc', True))
    return out


def build_movies(assets):
    """Story movies in reading order, with the sound the story plays with each (from its first use).

    Full-screen movies (IsBlocking) carry VideoVoiceFileName / BgmInfo cues timed against the video; the page's
    BGM plays on underneath unless BgmInfo replaces it. Looping movies have no sound of their own: the page's
    BGM (or looping SE) is their music.
    """
    db = sqlite3.connect(config.MASTER_DB)
    rows = db.execute('SELECT scenario_id, category, txt_path, title, subtitle FROM m_scenario').fetchall()
    db.close()
    rows.sort(key=lambda r: (r[1], int(r[0])))

    def find(name):
        for cand in (name, name + '.enc'):
            if cand in assets:
                return os.path.join(config.DOWNLOAD_DIR, assets[cand])
        return None

    movies = {}
    for sid, cat, txt, title, subtitle in rows:
        p = find(txt)
        if not p:
            continue
        try:
            pages = json.loads(t7scrypt.decode_path(p))['Pages']
        except Exception:
            continue
        prev = None
        for i, pg in enumerate(pages):
            # like the story player: InlineMovie (which carries the sound) wins over Movie
            m = pg.get('InlineMovie') or pg.get('Movie') or {}
            name = m.get('FileName')
            if not name or name == prev:
                prev = name
                continue
            prev = name
            snd = pg.get('Sound') or {}
            if name in movies:
                mv = movies[name]
                mv['uses'].append({'scenario': sid, 'page': i})
                # a reused loop may be silent where it first appears (birthday loop 28 in EPISODE 3.0)
                if not (mv['bgm'] or mv['loopSe'] or mv['voice'] or mv['bgmInfo']):
                    mv['bgm'] = snd.get('BgmFileName') or None
                    mv['loopSe'] = (snd.get('Se') or {}).get('LoopSeFileName') or None
                continue
            bgm_info = [{'cue': b['BgmFileName'], 'at': (b.get('StartTimeMilSec') or 0) / 1000}
                        for b in m.get('BgmInfo') or [] if b.get('BgmFileName')]
            real = assets.get(hashlib.sha1(name.encode('utf-8')).hexdigest().upper() + '.acb')
            movies[name] = {
                'file': name, 'category': cat, 'title': title or '', 'subtitle': subtitle or '',
                'loop': bool(m.get('IsLoop')), 'full': bool(m.get('IsBlocking')) and not m.get('IsLoop'),
                'voice': m.get('VideoVoiceFileName') or None, 'bgmInfo': bgm_info,
                'bgm': None if bgm_info else (snd.get('BgmFileName') or None),
                'loopSe': (snd.get('Se') or {}).get('LoopSeFileName') or None,
                'duration': mp4_duration(os.path.join(config.DOWNLOAD_DIR, real)) if real else None,
                'available': bool(real), 'uses': [{'scenario': sid, 'page': i}],
            }
    out = list(movies.values())
    db = sqlite3.connect(config.MASTER_DB)
    out += usm_movies(assets, db)
    db.close()
    for name in OTHER_MOVIES:
        real = assets.get(name)
        if real:
            out.append({'file': name, 'category': 'other', 'title': name, 'subtitle': '', 'series': '', 'loop': False, 'full': True,
                        'voice': None, 'bgmInfo': [], 'bgm': None, 'loopSe': None, 'own_audio': True,
                        'duration': mp4_duration(os.path.join(config.DOWNLOAD_DIR, real)), 'available': True, 'uses': []})
    return out


def main():
    os.makedirs(config.DATA_DIR, exist_ok=True)
    build_fonts()
    config.ensure_hcakey()
    assets = build_assets()
    print('assets:', len(assets))
    json.dump(assets, open(os.path.join(config.DATA_DIR, 'assets.json'), 'w', encoding='utf-8'))
    facepos = build_facepos(assets)
    print('face positions:', len(facepos))
    json.dump(facepos, open(os.path.join(config.DATA_DIR, 'facepos.json'), 'w', encoding='utf-8'))
    if '--no-audio' not in sys.argv:
        cues = build_cues(assets)
        print('audio cues:', len(cues))
        json.dump(cues, open(os.path.join(config.DATA_DIR, 'cues.json'), 'w', encoding='utf-8'))
    # after the cues: a live MV is only given its song if the song's cue exists
    movies = build_movies(assets)
    print('movies:', len(movies))
    json.dump(movies, open(os.path.join(config.DATA_DIR, 'movies.json'), 'w', encoding='utf-8'), ensure_ascii=False)


if __name__ == '__main__':
    main()
