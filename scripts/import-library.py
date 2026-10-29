#!/usr/bin/env python3
"""Import the owner-provided class roster and already-reviewed portrait groups.

Usage: python scripts/import-library.py roster.pdf /path/to/SLU_Class_Portraits
Requires pdfplumber and Pillow. Never identifies people from photographs.
"""
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import unicodedata

import pdfplumber
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

def read_roster(source):
    pages = []
    with pdfplumber.open(source) as pdf:
        if len(pdf.pages) != 6:
            raise ValueError('Expected the six-page M2029 roster with two matching lists.')
        for page in pdf.pages:
            rows = []
            for line in page.extract_text_lines():
                columns = []
                # Read columns by position: text extraction alone merges long surnames.
                for low, high in [(218, 298), (298, 369), (369, 400)]:
                    chars = [c for c in line['chars'] if low <= c['x0'] < high]
                    value = ''
                    for i, char in enumerate(chars):
                        if i and char['x0'] - chars[i - 1]['x1'] > 0.9:
                            value += ' '
                        value += char['text']
                    columns.append(value.strip())
                last, first, group = columns
                if group.isdigit() and last and first:
                    if not 1 <= int(group) <= 31:
                        raise ValueError(f'Unexpected group {group} for {first} {last}')
                    rows.append((last, first, group))
            pages.append(rows)
    by_name = [row for page in pages[:3] for row in page]
    by_group = [row for page in pages[3:] for row in page]
    if sorted(by_name) != sorted(by_group) or len(set(by_name)) != len(by_name):
        raise ValueError('Roster lists disagree or contain duplicate entries. Review source PDF.')
    roster = []
    for last, first, table in by_name:
        name = f'{first} {last}'
        identifier = re.sub(r'[^a-z0-9]+', '-', unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower()).strip('-')
        roster.append({'id': identifier, 'name': name, 'table': table})
    if len({row['id'] for row in roster}) != len(roster):
        raise ValueError('Duplicate name identifiers; resolve manually.')
    return sorted(roster, key=lambda row: row['name'].casefold())

def import_photos(library):
    library = library.resolve()
    mapping = json.loads((library / 'groupings.json').read_text())
    output = ROOT / 'private' / 'portraits'
    output.mkdir(parents=True, exist_ok=True)
    groups, seen, checksums = [], set(), {}
    for index, group in enumerate(mapping['people'], start=1):
        photos = []
        for source in group['sourceFiles']:
            identifier = source['id']
            if not re.fullmatch(r'[a-zA-Z0-9_-]+', identifier) or identifier in seen:
                raise ValueError(f'Invalid or duplicate source photograph: {identifier}')
            seen.add(identifier)
            path = (library / source['photo']).resolve()
            if not path.is_relative_to(library):
                raise ValueError('Source path escapes the portrait library.')
            with Image.open(path) as image:
                width, height = image.size
                if image.format != 'JPEG':
                    raise ValueError(f'Expected a JPEG: {path}')
            destination = output / f'{identifier}.jpg'
            shutil.copyfile(path, destination)
            digest = hashlib.sha256(destination.read_bytes()).hexdigest()
            checksums[destination.name] = digest
            photos.append({'id': identifier, 'path': f'/_portraits/{destination.name}', 'width': width, 'height': height})
        cover = next(photo['path'] for photo in photos if photo['id'] == group['selectedSourcePhotoId'])
        groups.append({'id': group['id'], 'label': f'Portrait {index:03d}', 'cover': cover, 'photos': photos})
    (ROOT / 'private' / 'portrait-checksums.json').write_text(json.dumps(checksums, indent=2) + '\n')
    return groups

if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    roster = read_roster(Path(sys.argv[1]))
    groups = import_photos(Path(sys.argv[2]))
    (ROOT / 'server').mkdir(exist_ok=True)
    (ROOT / 'server' / 'roster.json').write_text(json.dumps(roster, indent=2) + '\n')
    (ROOT / 'server' / 'photos.json').write_text(json.dumps(groups, indent=2) + '\n')
    print(f'Imported {len(roster)} roster names, {len(groups)} reviewed groups, and {sum(len(g["photos"]) for g in groups)} exact source photos.')
