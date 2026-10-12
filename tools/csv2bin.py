#!/usr/bin/env python3
"""Convertit un export MT5 (M1, séparé par tabulations) en fichier binaire compact pour l'Arène.
Usage : python3 tools/csv2bin.py USTEC_M1.csv data/ustec-m1.bin
Format (little-endian) : 'MKT1' | N u32 | t0 (minutes depuis 1970, heure du serveur lue comme UTC) u32 | échelle u32 (100)
puis dt u16[N] (minutes depuis la bougie précédente, 0 pour la première), padding à 4 octets, o,h,l,c i32[N] (prix × 100), v u32[N]."""
import csv, struct, sys, datetime as dt, gzip, array
src, dst = sys.argv[1], sys.argv[2]
T, O, H, L, C, V = [], [], [], [], [], []
epoch = dt.datetime(1970, 1, 1)
with open(src, newline='') as f:
    r = csv.reader(f, delimiter='\t'); next(r)
    for x in r:
        t = int((dt.datetime.strptime(x[0] + ' ' + x[1], '%Y.%m.%d %H:%M:%S') - epoch).total_seconds() // 60)
        o, h, l, c = (round(float(v) * 100) for v in x[2:6])
        if not (h >= max(o, c) and l <= min(o, c) and l > 0) or (T and t <= T[-1]): continue
        T.append(t); O.append(o); H.append(h); L.append(l); C.append(c); V.append(max(0, int(x[6])))
n = len(T); d = array.array('H', [0] + [min(65535, T[i] - T[i - 1]) for i in range(1, n)])
b = bytearray(b'MKT1' + struct.pack('<III', n, T[0], 100)) + d.tobytes()
b += b'\0' * (-len(b) % 4)
for a in (O, H, L, C): b += array.array('i', a).tobytes()
b += array.array('I', V).tobytes()
open(dst, 'wb').write(b); print(n, 'bougies,', len(b) // 1024, 'Ko,', len(gzip.compress(bytes(b))) // 1024, 'Ko gzip')
