#!/usr/bin/env python3
"""Add photos to the Sanctuary photo page (photos.html).

    python3 tools/add-photos.py <album-id> <photo> [<photo> ...] [--labels "Speakers,Team"]

For each photo it writes, in photos/<album-id>/:
  <name>.webp        full size, longest side at most 2400 px
  <name>-thumb.webp  600 px wide, for the grid
and prints the PHOTOS entries to paste into photos.js (labels and caption
are yours to fill in or adjust). Camera rotation is applied, and location
and camera metadata (EXIF) are dropped from the published files.
Needs Pillow:  pip install pillow
"""
import argparse
import json
import os
import re
import sys

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_SIDE = 2400
THUMB_W = 600


def slug(s):
    s = re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')
    return s or 'photo'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('album')
    ap.add_argument('photos', nargs='+')
    ap.add_argument('--labels', default='', help='comma-separated labels for every photo in this batch')
    a = ap.parse_args()
    if not re.fullmatch(r'[a-z0-9-]+', a.album):
        sys.exit('Album id: lowercase letters, numbers and dashes only, e.g. pal-forward-2026')
    out_dir = os.path.join(ROOT, 'photos', a.album)
    os.makedirs(out_dir, exist_ok=True)
    labels = [x.strip() for x in a.labels.split(',') if x.strip()]
    entries = []
    for path in a.photos:
        name = slug(os.path.splitext(os.path.basename(path))[0])
        base = name
        n = 2
        while os.path.exists(os.path.join(out_dir, base + '.webp')):
            base = '%s-%d' % (name, n)
            n += 1
        im = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
        im.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
        im.save(os.path.join(out_dir, base + '.webp'), 'WEBP', quality=84, method=6)   # no exif= : metadata dropped
        th = im.copy()
        th.thumbnail((THUMB_W, THUMB_W * 4), Image.LANCZOS)
        th.save(os.path.join(out_dir, base + '-thumb.webp'), 'WEBP', quality=80, method=6)
        entries.append({'file': 'photos/%s/%s.webp' % (a.album, base), 'album': a.album,
                        'labels': labels, 'caption': '', 'w': im.width, 'h': im.height})
        print('  wrote photos/%s/%s.webp (%dx%d)' % (a.album, base, im.width, im.height), file=sys.stderr)
    print('\n/* paste into PHOTOS in photos.js */')
    for e in entries:
        print('  ' + json.dumps(e, ensure_ascii=False).replace('"file"', 'file').replace('"album"', 'album')
              .replace('"labels"', 'labels').replace('"caption"', 'caption').replace('"w"', 'w').replace('"h"', 'h') + ',')


if __name__ == '__main__':
    main()
