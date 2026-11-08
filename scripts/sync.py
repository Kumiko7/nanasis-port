"""Copy new game data from BlueStacks (adb) into the archive, then rebuild the viewer indexes.

usage: python scripts/sync.py              pull from the device, then rebuild
       python scripts/sync.py --no-pull    only rebuild from what is already archived
env:   T7S_ADB (adb.exe path), T7S_DEVICE (default 127.0.0.1:5555)
"""
import os
import subprocess
import sys

import build_index
import build_master
import check_refs
import config

ADB = os.environ.get('T7S_ADB', os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk', 'platform-tools', 'adb.exe'))
DEVICE = os.environ.get('T7S_DEVICE', '127.0.0.1:5555')
REMOTE = '/sdcard/Android/data/jp.ne.donuts.t7s/files'
# tmp/ and cache/ change while the game runs and are not needed
FOLDERS = ['masterData', 'resourceMeta', 'download', 'setup_resource.json']


def adb(*args, **kw):
    return subprocess.run([ADB, '-s', DEVICE, *args], **kw)


def pull():
    subprocess.run([ADB, 'connect', DEVICE], capture_output=True)
    if adb('get-state', capture_output=True, text=True).stdout.strip() != 'device':
        sys.exit('BlueStacks not reachable at %s - enable ADB in BlueStacks settings.' % DEVICE)
    os.makedirs(config.ARCHIVE_DIR, exist_ok=True)
    have = set(os.listdir(config.DOWNLOAD_DIR)) if os.path.isdir(config.DOWNLOAD_DIR) else set()
    listing = adb('shell', 'ls', REMOTE + '/download', capture_output=True, text=True, encoding='utf-8').stdout.split()
    new = [n for n in listing if n not in have and '.' in n]
    print('device has %d downloaded files, %d new' % (len(listing), len(new)))
    # master tables and metadata are small - always refresh them
    for name in ('masterData', 'resourceMeta', 'setup_resource.json'):
        adb('pull', REMOTE + '/' + name, config.ARCHIVE_DIR, capture_output=True)
    os.makedirs(config.DOWNLOAD_DIR, exist_ok=True)
    for i in range(0, len(new), 200):  # batch to keep command lines short
        batch = [REMOTE + '/download/' + n for n in new[i:i + 200]]
        adb('pull', *batch, config.DOWNLOAD_DIR, capture_output=True)
        print('  pulled %d/%d' % (min(i + 200, len(new)), len(new)))


def main():
    if '--no-pull' not in sys.argv:
        pull()
    print('rebuilding master database...')
    build_master.main(config.ARCHIVE_DIR, config.MASTER_DB)
    print('rebuilding indexes...')
    build_index.main()
    print('checking which stories have all their assets...')
    check_refs.write_completeness()
    print('done. If the viewer is running, reload the page (or visit /api/reload).')


if __name__ == '__main__':
    main()
