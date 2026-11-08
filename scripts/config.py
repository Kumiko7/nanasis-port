import os

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPTS)          # the viewer folder
PROJECT = os.path.dirname(ROOT)


def _first_existing(*paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return paths[0]


# Game data: an `archive` folder next to (or inside) the viewer folder, holding `files/` copied from BlueStacks.
ARCHIVE_DIR = os.environ.get('T7S_ARCHIVE') or _first_existing(
    os.path.join(ROOT, 'archive', 'files'),
    os.path.join(PROJECT, 'archive', 'files'))
DOWNLOAD_DIR = os.path.join(ARCHIVE_DIR, 'download')

# The game's CRI key (CriWareDecrypter): HCA audio and USM video are both encrypted with it
CRI_KEY = 18279639311550860193


def ensure_hcakey():
    """Give vgmstream the game's HCA key as a `.hcakey` file next to the banks. Without one it guesses the key from
    each track's opening frames, and a track that opens with long silence (e.g. vo_ep6_06_m02, silent for 111 s)
    can get a wrong key and decode to loud noise."""
    path = os.path.join(DOWNLOAD_DIR, '.hcakey')
    key = CRI_KEY.to_bytes(8, 'big')
    if os.path.isdir(DOWNLOAD_DIR):
        try:
            with open(path, 'rb') as f:
                if f.read() == key:
                    return
        except OSError:
            pass
        with open(path, 'wb') as f:
            f.write(key)


# Bundled tools
VGMSTREAM = os.environ.get('T7S_VGMSTREAM', os.path.join(ROOT, 'tools', 'vgmstream', 'vgmstream-cli.exe'))

DATA_DIR = os.path.join(ROOT, 'data')
MASTER_DB = os.path.join(DATA_DIR, 'master.sqlite')
# The two things the viewer needs from the APK (fonts, built-in face positions) are kept in data/;
# the APK is only used to re-extract them if they are missing.
BUILTIN_DIR = os.path.join(DATA_DIR, 'builtin')
BASE_APK = os.environ.get('T7S_APK') or _first_existing(
    os.path.join(ROOT, 'archive', 'base.apk'),
    os.path.join(PROJECT, 'apk', 'base.apk'))

HOST = '127.0.0.1'
PORT = int(os.environ.get('T7S_PORT', '7777'))
