"""Report which assets referenced by downloaded scripts are missing from the archive.

usage: python scripts/check_refs.py [-v]      print a summary (and top missing names with -v)
Also used by sync.py to write data/completeness.json (per-scenario missing counts).
"""
import collections
import hashlib
import json
import os
import re
import sqlite3
import sys
import unicodedata

import config
import t7scrypt


def clean_cue(name):
    """Undo voice-name typos in the scripts: 'VO vo_ing3_000_13_01_001', 'vo_ing3_003_01_01_12１' (full-width
    digit) and a lone ' '. The game looks names up as written, so it plays neither recording."""
    return re.sub(r'^VO\s+', '', unicodedata.normalize('NFKC', name)).strip()


def se_cue(name):
    return 'se_%03d' % int(name) if name.isdigit() else name


def chara_parts(name):
    m = re.match(r'^adv_chara_(\d+)_(\d+)(?:_(\d+))?', name.strip())
    if not m:
        return [name.strip() + '.png'], None
    key = m.group(1) + '_' + m.group(2)
    parts = ['adv_chara_%s.png' % key]
    if m.group(3):
        parts.append('adv_chara_%s_%s.png' % (key, m.group(3)))
    return parts, key


def page_refs(p):
    """Yield (kind, name, is_audio_cue) for everything a page needs."""
    bg = p.get('BackGround') or {}
    for k in ('FileName', 'CrossFadeToFileName'):
        if bg.get(k):
            yield 'background', bg[k], False
    for c in p.get('Charas') or []:
        if c and (c.get('FileName') or '').strip():
            for f in chara_parts(c['FileName'])[0]:
                yield 'character image', f, False
    if (p.get('Item') or {}).get('FileName'):
        yield 'item', p['Item']['FileName'] + '.png', False
    snd = p.get('Sound') or {}
    if clean_cue(snd.get('VoiceFileName') or ''):
        yield 'voice', clean_cue(snd['VoiceFileName']), True
    if snd.get('BgmFileName'):
        yield 'bgm', snd['BgmFileName'], True
    se = snd.get('Se') or {}
    for k in ('SeFileName', 'Se2FileName', 'LoopSeFileName'):
        if se.get(k):
            yield 'se', se_cue(se[k]), True
    t = p.get('Title') or {}
    for k in ('EpisodeNameFileName', 'EpisodeNumberFileName'):
        if t.get(k):
            yield 'title image', t[k], False
    m = p.get('InlineMovie') or p.get('Movie') or {}
    if m.get('FileName'):
        yield 'movie', m['FileName'], False


def scan():
    assets = json.load(open(os.path.join(config.DATA_DIR, 'assets.json'), encoding='utf-8'))
    cues = json.load(open(os.path.join(config.DATA_DIR, 'cues.json'), encoding='utf-8'))

    def present(name, is_cue):
        if is_cue:
            return name in cues
        if name.endswith('.mp4'):  # videos are stored as <SHA1 of name>.acb
            return hashlib.sha1(name.encode('utf-8')).hexdigest().upper() + '.acb' in assets
        return name in assets or name + '.enc' in assets

    db = sqlite3.connect(config.MASTER_DB)
    refs = collections.Counter()
    missing = collections.defaultdict(collections.Counter)
    per_scenario = {}
    bad = []
    for sid, txt in db.execute('SELECT scenario_id, txt_path FROM m_scenario'):
        # one table entry (bdmemory_0632_1111.json) omits the .enc its file has
        real = assets.get(txt) or assets.get(txt + '.enc')
        if not real:
            continue
        try:
            pages = json.loads(t7scrypt.decode_path(os.path.join(config.DOWNLOAD_DIR, real)))['Pages']
        except Exception as e:
            bad.append((txt, str(e)[:80]))
            continue
        seen, miss = set(), set()
        for p in pages:
            for kind, name, is_cue in page_refs(p):
                refs[kind] += 1
                seen.add(name)
                if not present(name, is_cue):
                    missing[kind][name] += 1
                    miss.add(name)
        per_scenario[sid] = {'assets': len(seen), 'missing': len(miss)}
    db.close()
    return refs, missing, per_scenario, bad


def write_completeness():
    _, _, per_scenario, _ = scan()
    with open(os.path.join(config.DATA_DIR, 'completeness.json'), 'w', encoding='utf-8') as f:
        json.dump(per_scenario, f)
    complete = sum(1 for v in per_scenario.values() if not v['missing'])
    print('stories with every asset present: %d of %d downloaded scripts' % (complete, len(per_scenario)))


def main():
    refs, missing, per_scenario, bad = scan()
    print('scripts checked: %d  (unreadable: %d)' % (len(per_scenario), len(bad)))
    for s, e in bad:
        print('  unreadable', s, e)
    for kind in sorted(refs):
        miss = sum(missing[kind].values())
        print('%-16s %7d refs  %6d missing (%d distinct)' % (kind, refs[kind], miss, len(missing[kind])))
        if '-v' in sys.argv:
            for name, n in missing[kind].most_common(8):
                print('      %5d x %s' % (n, name))
    complete = sum(1 for v in per_scenario.values() if not v['missing'])
    print('stories with every asset present: %d' % complete)


if __name__ == '__main__':
    main()
