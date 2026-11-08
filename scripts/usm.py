"""CRI USM movies (the live music videos M###.enc, music_pv, furifurimode_tutorial): demux and unmask.

The video stream is H.264, masked with the game's CRI key (CriWareDecrypter, from the game's string table);
the first 0x40 bytes of each frame are clear. Audio chunks (when present) are HCA, masked the same way.
"""
import struct

from config import CRI_KEY as KEY


def _masks(key):
    k1 = (key & 0xFFFFFFFF).to_bytes(4, 'little')
    k2 = (key >> 32).to_bytes(4, 'little')
    t = bytearray(0x20)
    t[0x00] = k1[0]
    t[0x01] = k1[1]
    t[0x02] = k1[2]
    t[0x03] = (k1[3] - 0x34) & 0xFF
    t[0x04] = (k2[0] + 0xF9) & 0xFF
    t[0x05] = k2[1] ^ 0x13
    t[0x06] = (k2[2] + 0x61) & 0xFF
    t[0x07] = t[0x00] ^ 0xFF
    t[0x08] = (t[0x02] + t[0x01]) & 0xFF
    t[0x09] = (t[0x01] - t[0x07]) & 0xFF
    t[0x0A] = t[0x02] ^ 0xFF
    t[0x0B] = t[0x01] ^ 0xFF
    t[0x0C] = (t[0x0B] + t[0x09]) & 0xFF
    t[0x0D] = (t[0x08] - t[0x03]) & 0xFF
    t[0x0E] = t[0x0D] ^ 0xFF
    t[0x0F] = (t[0x0A] - t[0x0B]) & 0xFF
    t[0x10] = (t[0x08] - t[0x0F]) & 0xFF
    t[0x11] = t[0x10] ^ t[0x07]
    t[0x12] = t[0x0F] ^ 0xFF
    t[0x13] = t[0x03] ^ 0x10
    t[0x14] = (t[0x04] - 0x32) & 0xFF
    t[0x15] = (t[0x05] + 0xED) & 0xFF
    t[0x16] = t[0x06] ^ 0xF3
    t[0x17] = (t[0x13] - t[0x0F]) & 0xFF
    t[0x18] = (t[0x15] + t[0x07]) & 0xFF
    t[0x19] = (0x21 - t[0x13]) & 0xFF
    t[0x1A] = t[0x14] ^ t[0x17]
    t[0x1B] = (t[0x16] + t[0x16]) & 0xFF
    t[0x1C] = (t[0x17] + 0x44) & 0xFF
    t[0x1D] = (t[0x03] + t[0x04]) & 0xFF
    t[0x1E] = (t[0x05] - t[0x16]) & 0xFF
    t[0x1F] = t[0x1D] ^ t[0x13]
    video1 = bytes(t)
    video2 = bytes(b ^ 0xFF for b in t)
    audio = bytes((b'URUC'[(i >> 1) & 3] if i & 1 else t[i] ^ 0xFF) for i in range(0x20))
    return video1, video2, audio


VIDEO1, VIDEO2, AUDIO = _masks(KEY)
_V1 = int.from_bytes(VIDEO1, 'big')
_V2 = int.from_bytes(VIDEO2, 'big')


def unmask_video(frame):
    """Undo the mask on one video frame (bytes after 0x40: a running XOR in 32-byte steps)."""
    size = len(frame) - 0x40
    if size < 0x200:
        return frame
    d = bytearray(frame)
    base = 0x40
    # bytes 0x100.. : plain[j] = cipher[j] ^ video2 ^ plain[j-32]
    prev = 0
    j = 0x100
    while j < size:
        n = min(32, size - j)
        c = int.from_bytes(d[base + j:base + j + n], 'big')
        if n == 32:
            p = c ^ _V2 ^ prev
            prev = p
        else:
            p = c ^ ((_V2 ^ prev) >> (8 * (32 - n)))
        d[base + j:base + j + n] = p.to_bytes(n, 'big')
        j += 32
    # bytes 0..0xFF : the mask (from video1) accumulates the plain bytes 0x100 further on
    m = _V1
    for j in range(0, 0x100, 32):
        m ^= int.from_bytes(d[base + 0x100 + j:base + 0x100 + j + 32], 'big')
        c = int.from_bytes(d[base + j:base + j + 32], 'big')
        d[base + j:base + j + 32] = (c ^ m).to_bytes(32, 'big')
    return bytes(d)


def unmask_audio(frame):
    if len(frame) < 0x140:
        return frame
    d = bytearray(frame)
    for j in range(0x140, len(d)):
        d[j] ^= AUDIO[j & 0x1F]
    return bytes(d)


def utf_table(b):
    """Rows of a CRI @UTF table as dicts (used for the USM stream headers)."""
    if b[:4] != b'@UTF':
        return []
    t = b[8:]
    rows_off, str_off, data_off = struct.unpack('>HII', t[2:12])
    ncols, row_len, nrows = struct.unpack('>HHI', t[16:24])

    def cstr(off):
        s = t[str_off + off:t.index(b'\0', str_off + off)]
        return s.decode('utf-8', 'replace')
    fmt = {0: '>B', 1: '>b', 2: '>H', 3: '>h', 4: '>I', 5: '>i', 6: '>Q', 7: '>q', 8: '>f', 9: '>d', 0xA: '>I', 0xB: '>II'}

    def value(typ, pos):
        f = fmt[typ]
        v = struct.unpack(f, t[pos:pos + struct.calcsize(f)])
        if typ == 0xA:
            return cstr(v[0]), struct.calcsize(f)
        if typ == 0xB:
            return t[data_off + v[0]:data_off + v[0] + v[1]], 8
        return v[0], struct.calcsize(f)
    cols, pos = [], 24
    for _ in range(ncols):
        flags = t[pos]
        name = cstr(struct.unpack('>I', t[pos + 1:pos + 5])[0])
        pos += 5
        const = None
        if flags & 0xF0 == 0x30:
            const, n = value(flags & 0x0F, pos)
            pos += n
        cols.append((name, flags, const))
    rows = []
    for r in range(nrows):
        p = rows_off + r * row_len
        row = {}
        for name, flags, const in cols:
            storage = flags & 0xF0
            if storage == 0x50:
                row[name], n = value(flags & 0x0F, p)
                p += n
            elif storage == 0x30:
                row[name] = const
        rows.append(row)
    return rows


def video_info(data):
    """width / height / frame rate / frame count from the @SFV stream header."""
    for sig, typ, ch, pl in chunks(data):
        if sig == b'@SFV' and typ == 1:
            rows = utf_table(pl)
            if rows:
                return rows[0]
    return {}


def chunks(data):
    """(signature, type, channel, payload) for each USM chunk; type 0 = stream data."""
    pos = 0
    while pos + 0x20 <= len(data):
        sig = data[pos:pos + 4]
        size = struct.unpack('>I', data[pos + 4:pos + 8])[0]
        off = data[pos + 9]
        pad = struct.unpack('>H', data[pos + 10:pos + 12])[0]
        ch = data[pos + 12]
        typ = data[pos + 15] & 3
        yield sig, typ, ch, data[pos + 8 + off:pos + 8 + size - pad]
        pos += 8 + size


def _box(kind, *parts):
    body = b''.join(parts)
    return struct.pack('>I', 8 + len(body)) + kind + body


def _full(kind, version, flags, *parts):
    return _box(kind, struct.pack('>I', (version << 24) | flags), *parts)


_MATRIX = struct.pack('>9I', 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000)


def h264_to_mp4(es, fps_n, fps_d, width, height):
    """Wrap an H.264 Annex B stream (no B-frames, one access unit per frame) in a playable MP4.

    Frames are split at the access unit delimiters; SPS / PPS go into avcC (and stay in-band); every
    frame lasts fps_d / fps_n seconds. moov comes first so the browser can start before the end arrives.
    """
    starts = []
    i = es.find(b'\x00\x00\x01')
    while i >= 0:
        starts.append(i)
        i = es.find(b'\x00\x00\x01', i + 3)
    nals = []
    for n, s in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(es)
        nal = es[s + 3:end]
        while nal.endswith(b'\x00') and n + 1 < len(starts):   # zero byte belonging to the next 4-byte start code
            nal = nal[:-1]
        nals.append(nal)
    sps = next(x for x in nals if x[0] & 0x1F == 7)
    pps = next(x for x in nals if x[0] & 0x1F == 8)
    samples, sync, cur, key = [], [], bytearray(), False
    for nal in nals:
        t = nal[0] & 0x1F
        if t == 9 and cur:
            samples.append(bytes(cur))
            if key:
                sync.append(len(samples))
            cur, key = bytearray(), False
        if t == 9:
            continue
        cur += struct.pack('>I', len(nal)) + nal
        key = key or t == 5
    if cur:
        samples.append(bytes(cur))
        if key:
            sync.append(len(samples))
    count = len(samples)
    duration = count * fps_d

    avcc = _box(b'avcC', bytes([1, sps[1], sps[2], sps[3], 0xFF, 0xE1]), struct.pack('>H', len(sps)), sps,
                b'\x01', struct.pack('>H', len(pps)), pps)
    avc1 = _box(b'avc1', b'\0' * 6, struct.pack('>H', 1), b'\0' * 16, struct.pack('>HH', width, height),
                struct.pack('>II', 0x480000, 0x480000), b'\0' * 4, struct.pack('>H', 1), b'\0' * 32,
                struct.pack('>Hh', 0x18, -1), avcc)

    def moov(offset):
        stbl = _box(b'stbl',
                    _full(b'stsd', 0, 0, struct.pack('>I', 1), avc1),
                    _full(b'stts', 0, 0, struct.pack('>III', 1, count, fps_d)),
                    _full(b'stss', 0, 0, struct.pack('>I', len(sync)), struct.pack('>%dI' % len(sync), *sync)),
                    _full(b'stsc', 0, 0, struct.pack('>IIII', 1, 1, count, 1)),
                    _full(b'stsz', 0, 0, struct.pack('>II', 0, count), struct.pack('>%dI' % count, *map(len, samples))),
                    _full(b'stco', 0, 0, struct.pack('>II', 1, offset)))
        minf = _box(b'minf', _full(b'vmhd', 0, 1, b'\0' * 8),
                    _box(b'dinf', _full(b'dref', 0, 0, struct.pack('>I', 1), _full(b'url ', 0, 1))), stbl)
        mdia = _box(b'mdia', _full(b'mdhd', 0, 0, struct.pack('>IIIIHH', 0, 0, fps_n, duration, 0x55C4, 0)),
                    _full(b'hdlr', 0, 0, b'\0' * 4, b'vide', b'\0' * 12, b'VideoHandler\0'), minf)
        tkhd = _full(b'tkhd', 0, 3, struct.pack('>IIIII', 0, 0, 1, 0, duration), b'\0' * 8,
                     struct.pack('>hhhH', 0, 0, 0, 0), _MATRIX, struct.pack('>II', width << 16, height << 16))
        mvhd = _full(b'mvhd', 0, 0, struct.pack('>IIIIIH', 0, 0, fps_n, duration, 0x10000, 0x100), b'\0' * 10,
                     _MATRIX, b'\0' * 24, struct.pack('>I', 2))
        return _box(b'moov', mvhd, _box(b'trak', tkhd, mdia))
    ftyp = _box(b'ftyp', b'isom', struct.pack('>I', 0x200), b'isomiso2avc1mp41')
    head = len(ftyp) + len(moov(0)) + 8
    mdat_body = b''.join(samples)
    return ftyp + moov(head) + struct.pack('>I', 8 + len(mdat_body)) + b'mdat' + mdat_body


def to_mp4(data):
    """A USM file's video as MP4 bytes."""
    info = video_info(data)
    es, _ = demux(data)
    return h264_to_mp4(es, info['framerate_n'], info['framerate_d'], info['width'], info['height'])


def demux(data):
    """-> (H.264 Annex B elementary stream, list of audio frames)."""
    video, audio = bytearray(), []
    for sig, typ, ch, pl in chunks(data):
        if typ != 0 or (pl[:8] == b'#CONTENT' or pl[:8] == b'#HEADER '):
            continue
        if sig == b'@SFV':
            video += unmask_video(pl)
        elif sig == b'@SFA':
            audio.append(pl)
    return bytes(video), audio
