"""Decrypt every masterData/*.sql.enc and load it into a single SQLite database.

usage: python scripts/build_master.py <archive files dir> <out.sqlite>
"""
import glob
import os
import re
import sqlite3
import sys

import t7scrypt

INSERT_RE = re.compile(r"REPLACE INTO `(\w+)` \(([^)]*)\) VALUES", re.I)


def load(db, sql):
    if not INSERT_RE.search(sql):
        return  # empty table: the script is only a DELETE
    for m in INSERT_RE.finditer(sql):
        table = m.group(1)
        cols = [c.strip('` ') for c in m.group(2).split(',')]
        db.execute('CREATE TABLE IF NOT EXISTS "%s" (%s)' % (table, ','.join('"%s"' % c for c in cols)))
        existing = [r[1] for r in db.execute('PRAGMA table_info("%s")' % table)]
        for c in cols:
            if c not in existing:
                db.execute('ALTER TABLE "%s" ADD COLUMN "%s"' % (table, c))
    # Statements use MySQL-style backticks and backslash escapes; normalise for SQLite.
    sql = re.sub(r"(?i)^delete from (\w+);", r'DELETE FROM "\1";', sql, flags=re.M)
    sql = sql.replace("\\'", "''").replace('\\"', '"').replace('\\n', '\n').replace('\\\\', '\\')
    db.executescript(sql)


def main(src, out):
    if os.path.exists(out):
        os.remove(out)
    db = sqlite3.connect(out)
    ok = bad = 0
    for path in sorted(glob.glob(os.path.join(src, 'masterData', '*.sql.enc'))):
        try:
            sql = t7scrypt.decode_path(path).decode('utf-8')
            load(db, sql)
            ok += 1
        except Exception as e:  # keep going; report at the end
            bad += 1
            print('FAILED', os.path.basename(path)[:60], e)
    db.commit()
    print('tables loaded: %d, failed: %d' % (ok, bad))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
