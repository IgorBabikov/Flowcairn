"""Safely extract downloaded Standard archives and record exact per-file hashes."""
import hashlib
import json
import zipfile
from pathlib import Path

BASE = Path('output/product-completion/rpg')
for archive in sorted((BASE / 'sources').glob('*-standard.zip')):
    provenance = json.loads(archive.with_name(archive.stem.removesuffix('-standard') + '-provenance.json').read_text())
    if hashlib.sha256(archive.read_bytes()).hexdigest() != provenance['sha256']:
        raise RuntimeError('Archive hash mismatch: ' + archive.name)
    destination = BASE / 'extracted' / archive.stem
    destination.mkdir(parents=True, exist_ok=True)
    entries = []
    with zipfile.ZipFile(archive) as source:
        for info in source.infolist():
            relative = Path(info.filename)
            if relative.is_absolute() or '..' in relative.parts:
                raise RuntimeError('Unsafe archive path')
            if info.is_dir():
                continue
            data = source.read(info)
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            entries.append(dict(path=info.filename, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
    (BASE / 'sources' / (archive.stem + '-inventory.json')).write_text(json.dumps(entries, indent=2) + '\n')
    print(archive.name, len(entries), 'files')
