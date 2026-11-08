"""Decryption for Tokyo 7th Sisters asset files (Donuts.Crypt.Manager).

EncVersion 1: [iv 16][aes-128-cbc body]            key = privateKey
EncVersion 2: ['t7s-enc'][iv 16][aes-128-cbc body] key = privateKey2 ^ (i*13 + 0x25)
Body is PKCS7-padded; optionally LZ4 block compressed with a 4-byte LE size prefix.
"""
import struct
from Crypto.Cipher import AES

SIGNATURE = b't7s-enc'
KEY_V1 = b'3HGWxMZz6f2egL84'
KEY_V2 = bytes(b ^ ((i * 13 + 0x25) & 0xFF) for i, b in enumerate(b'J9h4j5eNds+aq1=='))


def lz4_block_decode(src, size):
    dst = bytearray()
    i, n = 0, len(src)
    while i < n:
        token = src[i]
        i += 1
        lit = token >> 4
        if lit == 15:
            while True:
                b = src[i]
                i += 1
                lit += b
                if b != 255:
                    break
        dst += src[i:i + lit]
        i += lit
        if i >= n:
            break
        off = src[i] | (src[i + 1] << 8)
        i += 2
        ml = token & 15
        if ml == 15:
            while True:
                b = src[i]
                i += 1
                ml += b
                if b != 255:
                    break
        ml += 4
        start = len(dst) - off
        if off >= ml:
            dst += dst[start:start + ml]
        else:
            for k in range(ml):
                dst.append(dst[start + k])
    if size is not None and len(dst) != size:
        raise ValueError('lz4 size mismatch %d != %d' % (len(dst), size))
    return bytes(dst)


def decrypt(data):
    if data[:7] == SIGNATURE:
        iv, body, key = data[7:23], data[23:], KEY_V2
    else:
        iv, body, key = data[:16], data[16:], KEY_V1
    if not body or len(body) % 16:
        raise ValueError('not an encrypted asset')
    p = AES.new(key, AES.MODE_CBC, iv).decrypt(body)
    pad = p[-1]
    if not 1 <= pad <= 16 or p[-pad:] != bytes([pad]) * pad:
        raise ValueError('bad padding (wrong key?)')
    return p[:-pad]


def maybe_lz4(p):
    """Undo the optional LZ4 layer: 4-byte LE decoded size followed by an LZ4 block."""
    if len(p) > 4:
        size = struct.unpack_from('<i', p)[0]
        # tiny inputs can grow under LZ4, so only bound the size; the exact-length check validates it
        if 0 < size < 64 * 1024 * 1024:
            try:
                return lz4_block_decode(p[4:], size)
            except (ValueError, IndexError):
                pass
    return p


def decode_file(data):
    """Decrypt and decompress; returns plaintext bytes.

    LZ4 is tried first: its size prefix can itself begin with '{' or similar,
    while real file magics (PNG, JPEG, JSON text) decode to implausibly large sizes.
    """
    return maybe_lz4(decrypt(data))


def decode_path(path):
    with open(path, 'rb') as f:
        return decode_file(f.read())
