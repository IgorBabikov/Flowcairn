"""Download only public, zero-price Quaternius Standard uploads.

Uses the same public download endpoints exposed by itch.io's purchase page.
No login, payment, quarantine bypass, or paid upload requests are supported.
Transient CSRF and signed download URLs are never written to provenance.
"""
import argparse
import hashlib
import http.cookiejar
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

PACKS = {
    'medieval-village-megakit': 'medievalvillagemegakit',
    'universal-base-characters': 'universalbasecharacters',
    'modular-character-outfits-fantasy': 'modularcharacteroutfitsfantasy',
    'universal-animation-library': 'universalanimationlibrary',
}
LOCK = json.loads((Path(__file__).parent / 'standard-sources.lock.json').read_text())
PINNED = {record['pack']:record for record in LOCK['packs']}

def download(slug, destination):
    pinned=PINNED[slug]
    target=destination/(slug+'-standard.zip')
    if target.exists():
        if hashlib.sha256(target.read_bytes()).hexdigest()!=pinned['sha256']:
            raise RuntimeError('Existing archive differs from pinned snapshot; preserve and review it')
        (destination/(slug+'-provenance.json')).write_text(json.dumps(pinned,indent=2)+'\n')
        print('VERIFIED_CACHE '+slug+' '+pinned['sha256'],flush=True)
        return
    base = 'https://quaternius.itch.io/' + slug
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    opener.addheaders = [('User-Agent', 'Flowcairn-Art-Asset-Inventory/1.0')]
    def fetch(url, data=None):
        with opener.open(url, data=data, timeout=90) as response:
            return response.read()
    purchase = fetch(base + '/purchase').decode()
    if not re.search(r'"actual_price"\s*:\s*0', purchase):
        raise RuntimeError('Public zero-price download not verified')
    csrf = re.search(r'name="csrf_token" value="([^"]+)"', purchase).group(1)
    route = json.loads(fetch(base + '/download_url', urllib.parse.urlencode({'csrf_token': csrf}).encode()))
    page = fetch(route['url']).decode()
    # Download pages expose a single button per upload. Select only Standard.
    blocks = re.findall(r'<div class="upload">(.*?)(?=<div class="upload">|</div></div><)', page)
    selected = None
    for block in blocks:
        if '[Standard].zip' in block:
            upload = re.search(r'data-upload_id="(\d+)"', block)
            name = re.search(r'title="([^"]*\[Standard\]\.zip)"', block)
            if upload and name:
                selected = (upload.group(1), name.group(1))
                break
    if not selected:
        raise RuntimeError('Standard upload not found; no alternative requested')
    if selected[0]!=pinned['uploadId']:
        raise RuntimeError('Upstream Standard upload changed; explicit new snapshot review required')
    csrf = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
    link = json.loads(fetch(base + '/file/' + selected[0], urllib.parse.urlencode({'csrf_token': csrf}).encode()))
    if 'url' not in link:
        raise RuntimeError('Download unavailable: ' + str(link.get('errors', 'requires user action')))
    temporary=destination/(slug+'-standard.zip.download')
    digest = hashlib.sha256()
    with opener.open(link['url'], timeout=90) as response, temporary.open('wb') as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            digest.update(chunk)
    if digest.hexdigest()!=pinned['sha256'] or temporary.stat().st_size!=pinned['bytes']:
        raise RuntimeError('Download differs from pinned snapshot; .download retained for review')
    temporary.rename(target)
    record = dict(pack=slug, edition='Standard', filename=selected[1], uploadId=selected[0],
                  source='https://quaternius.com/packs/' + PACKS[slug] + '.html',
                  downloadPage=base, sha256=digest.hexdigest(), bytes=target.stat().st_size,
                  license='CC0-1.0', licenseURL='https://creativecommons.org/publicdomain/zero/1.0/',
                  version='No semantic version published; exact upload ID and SHA256 identify snapshot')
    (destination / (slug + '-provenance.json')).write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record), flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, default=Path('output/product-completion/rpg/sources'))
    parser.add_argument('--pack', choices=PACKS, action='append')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for pack in args.pack or PACKS:
        download(pack, args.out)
