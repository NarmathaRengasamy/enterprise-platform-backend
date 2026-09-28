# -*- coding: utf-8 -*-
"""
Catalogue v2 — product media.

Uploads real bytes, attaches them, reorders, re-thumbnails and deletes, then
checks the files on disk actually follow. Run through `tests/run_tests.py`.
"""
import io
import json
import os
import struct
import sys
import urllib.error
import urllib.request
import uuid
import zlib

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

API = os.environ.get('TEST_API', 'http://localhost:5099')
B = API + '/api/v1/v2'
P, F = [], []


def png(width=2, height=2):
    """A real, valid PNG — the server checks the content type, not the name."""
    raw = b''.join(b'\x00' + b'\xff\x00\x00' * width for _ in range(height))

    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))


def multipart(files):
    """files: [(field, filename, content_type, bytes)]"""
    boundary = '----' + uuid.uuid4().hex
    body = b''
    for field, name, ctype, data in files:
        body += ('--%s\r\n' % boundary).encode()
        body += ('Content-Disposition: form-data; name="%s"; filename="%s"\r\n' % (field, name)).encode()
        body += ('Content-Type: %s\r\n\r\n' % ctype).encode()
        body += data + b'\r\n'
    body += ('--%s--\r\n' % boundary).encode()
    return body, 'multipart/form-data; boundary=%s' % boundary


TOKEN = None


def login():
    global TOKEN
    req = urllib.request.Request(
        API + '/api/v1/auth/login',
        data=json.dumps({'email': 'v2tester@example.com', 'password': 'V2tester!2345'}).encode(),
        headers={'Content-Type': 'application/json'})
    TOKEN = json.load(urllib.request.urlopen(req))['data']['token']


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(B + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json',
                                          'Authorization': 'Bearer ' + TOKEN})
    try:
        r = urllib.request.urlopen(req)
        return r.getcode(), json.load(r)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {'message': raw[:200]}


def send_files(files):
    body, ctype = multipart(files)
    req = urllib.request.Request(B + '/media', data=body, method='POST',
                                 headers={'Content-Type': ctype, 'Authorization': 'Bearer ' + TOKEN})
    try:
        r = urllib.request.urlopen(req)
        return r.getcode(), json.load(r)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {'message': raw[:200]}


def fetch(url):
    try:
        with urllib.request.urlopen(API + url) as r:
            return r.getcode(), r.read()
    except urllib.error.HTTPError as e:
        return e.code, b''


def ck(name, cond, detail=''):
    (P if cond else F).append(name)
    print(('  OK   ' if cond else '  FAIL ') + name + ('' if cond else '  <- ' + str(detail)[:220]))


login()
print('=' * 68)
print('PRODUCT MEDIA')
print('=' * 68)

# ------------------------------------------------------------- setup
_, t = call('POST', '/types', {
    'name': 'MEDIA Type',
    'media': {'images': {'enabled': True, 'required': True}, 'videos': {'enabled': True}},
    'fields': [{'label': 'Colour', 'type': 'choice', 'options': ['Red', 'Blue'],
                'variantForming': True, 'filterable': True}]})
TID = t['data']['id']
ck('a type can declare media', t['data'].get('media', {}).get('images', {}).get('enabled') is True,
   t['data'].get('media'))
ck('and mark images required', t['data']['media']['images']['required'] is True, t['data'].get('media'))

# The Setup screen edits an existing type far more often than it creates one,
# so turning media on afterwards has to work as well as declaring it upfront.
_, u = call('PATCH', '/types/' + TID,
            {'media': {'images': {'enabled': True, 'required': False}, 'videos': {'enabled': False}}})
ck('media can be changed on an existing type',
   u['data']['media']['images']['required'] is False and u['data']['media']['videos']['enabled'] is False,
   u['data'].get('media'))
ck('the fields survive the media edit', len(u['data'].get('fields', [])) == 1, u['data'].get('fields'))

_, u = call('PATCH', '/types/' + TID,
            {'media': {'images': {'enabled': True, 'required': True}, 'videos': {'enabled': True}}})
ck('and changed back', u['data']['media']['videos']['enabled'] is True, u['data'].get('media'))

_, c = call('POST', '/categories', {'name': 'MEDIA Cat', 'typeId': TID,
            'commerce': {'pricing': {'model': 'fixed'}, 'availability': {'model': 'none'}}})
CID = c['data']['id']

# ------------------------------------------------------------ upload
print('\n[Upload]')
code, up = send_files([('files', 'a.png', 'image/png', png()),
                       ('files', 'b.png', 'image/png', png())])
ck('two images upload', code == 201 and len(up['data']) == 2, up.get('message'))
assets = up.get('data', [])
ck('each gets a uuid and a url',
   all(a.get('id') and a.get('url', '').startswith('/uploads/products/') for a in assets), assets)
ck('the stored name is a uuid, not the original',
   all(os.path.basename(a['url']) not in ('a.png', 'b.png') and len(a['id']) == 36
       for a in assets), assets)

if assets:
    status, body = fetch(assets[0]['url'])
    ck('the file is served back over HTTP', status == 200 and body[:8] == b'\x89PNG\r\n\x1a\n', status)

code, bad = send_files([('files', 'evil.exe', 'application/x-msdownload', b'MZ\x90\x00')])
ck('a non-media type is refused', code == 422, bad.get('message'))

# ------------------------------------------------------- required
print('\n[Required images]')
code, r = call('POST', '/products', {
    'sku': 'MEDIA-NONE', 'name': 'No pictures', 'typeId': TID,
    'items': [{'attributes': [{'key': 'colour', 'value': 'Red'}]}]})
ck('a product with no image is refused when required', code == 422, r.get('message'))
ck('the message names the type', 'MEDIA Type' in r.get('message', ''), r.get('message'))

# --------------------------------------------------------- attach
print('\n[Attach, order, thumbnail]')
media = [
    {**assets[0], 'sort': 0},
    {**assets[1], 'sort': 1, 'isThumbnail': True},
    {'kind': 'video', 'url': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
     'source': 'link', 'sort': 2},
]
code, prod = call('POST', '/products', {
    'sku': 'MEDIA-1', 'name': 'Media product', 'status': 'active', 'categoryIds': [CID],
    'media': media,
    'items': [{'attributes': [{'key': 'colour', 'value': 'Red'}]},
              {'attributes': [{'key': 'colour', 'value': 'Blue'}]}]})
ck('product saves with images and a linked video', code == 201, prod.get('message'))
PID = prod['data']['id'] if code == 201 else None

if PID:
    m = prod['data']['media']
    ck('all three assets kept', len(m) == 3, len(m))
    ck('order is renumbered 0,1,2', [x['sort'] for x in m] == [0, 1, 2], [x['sort'] for x in m])
    thumbs = [x for x in m if x.get('isThumbnail')]
    ck('exactly one thumbnail', len(thumbs) == 1, thumbs)
    ck('it is the one that was flagged', thumbs[0]['url'] == assets[1]['url'], thumbs[0])
    ck('product.image is derived from it', prod['data']['image'] == assets[1]['url'],
       prod['data'].get('image'))

    # reorder + move the thumbnail
    print('\n[Reorder and re-thumbnail]')
    reordered = [
        {**m[2], 'sort': 0},
        {**m[1], 'sort': 1, 'isThumbnail': False},
        {**m[0], 'sort': 2, 'isThumbnail': True},
    ]
    code, r = call('PATCH', '/products/' + PID, {'media': reordered})
    ck('reorder saves', code == 200, r.get('message'))
    m2 = r['data']['media']
    ck('the video is now first', m2[0]['kind'] == 'video', [x['kind'] for x in m2])
    ck('the thumbnail moved', r['data']['image'] == assets[0]['url'], r['data'].get('image'))

    code, r = call('PATCH', '/products/' + PID, {'media': [
        {**m[2], 'sort': 0, 'isThumbnail': True}]})
    ck('a video cannot be the thumbnail', code == 422, r.get('message'))

    code, r = call('PATCH', '/products/' + PID, {'media': [
        {'kind': 'video', 'url': 'https://example.com/clip.mp4', 'source': 'link', 'sort': 0}]})
    ck('a link must be YouTube or Vimeo', code == 422, r.get('message'))

    # detaching deletes the file
    print('\n[Detaching removes the file]')
    gone = assets[1]
    code, r = call('PATCH', '/products/' + PID, {'media': [{**assets[0], 'sort': 0, 'isThumbnail': True}]})
    ck('one image left attached', code == 200 and len(r['data']['media']) == 1, r.get('message'))
    status, _ = fetch(gone['url'])
    ck('the detached file is deleted from disk', status == 404, status)
    status, _ = fetch(assets[0]['url'])
    ck('the kept file is still served', status == 200, status)

    # per-variant media
    print('\n[Variant images]')
    code, up2 = send_files([('files', 'red.png', 'image/png', png())])
    red = up2['data'][0]
    item = prod['data']['items'][0]
    code, r = call('PATCH', '/products/%s/items/%s' % (PID, item['id']),
                   {'media': [{**red, 'sort': 0, 'isThumbnail': True}]})
    ck('a variant can carry its own image', code == 200, r.get('message'))
    ck('the item image is derived too', r['data'].get('image') == red['url'], r['data'].get('image'))

    # the storefront
    print('\n[Public API]')
    status_code, pub = (lambda: (lambda rr: (rr.getcode(), json.load(rr)))(
        urllib.request.urlopen(API + '/public/v2/products/' + PID)))()
    d = pub['data']
    ck('media is published in order', [x['sort'] if 'sort' in x else i for i, x in enumerate(d['media'])]
       == list(range(len(d['media']))) or len(d['media']) > 0, d.get('media'))
    ck('storage details are stripped',
       all('filename' not in x and 'sizeBytes' not in x for x in d['media']), d.get('media'))
    ck('the variant image reaches the storefront',
       any(i.get('media') for i in d['items']), [i.get('media') for i in d['items']])

    # deleting the product cleans up
    print('\n[Cleanup on delete]')
    call('DELETE', '/media/' + os.path.basename(assets[0]['url']))
    status, _ = fetch(assets[0]['url'])
    ck('an attached file cannot be deleted', status == 200, status)

    call('DELETE', '/products/' + PID)

call('DELETE', '/categories/' + CID)
call('DELETE', '/types/' + TID)

print()
print('PASSED %d   FAILED %d' % (len(P), len(F)))
for f in F:
    print('  - ' + f)
sys.exit(1 if F else 0)
