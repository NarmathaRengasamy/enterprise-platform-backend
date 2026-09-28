# -*- coding: utf-8 -*-
"""
Catalogue v2 — open choice fields.

A choice field with no declared options is an OPEN one: the values are decided
per product. This suite covers both scopes, because they behave the same to a
user and used to behave differently underneath — a product-level open field was
outside the casing vocabulary, so it was the one place "128GB" and "128gb"
could both survive.

Run through `tests/run_tests.py`.
"""
import json
import os
import sys
import urllib.error
import urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

API = os.environ.get('TEST_API', 'http://localhost:5099')
B = API + '/api/v1/v2'
P, F = [], []
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


def ck(name, cond, detail=''):
    (P if cond else F).append(name)
    print(('  OK   ' if cond else '  FAIL ') + name + ('' if cond else '  <- ' + str(detail)[:220]))


def attrs_of(doc):
    return {a['key']: a['value'] for a in doc.get('attributes', [])}


def vals(entries):
    """The vocabulary is [{value, count}] — this suite mostly wants the values."""
    return [e['value'] for e in entries]


def count_of(entries, value):
    return next((e['count'] for e in entries if e['value'] == value), 0)


login()
print('=' * 68)
print('OPEN CHOICE FIELDS')
print('=' * 68)

# `storage` is open and product-level; `colour` is open and variant-forming.
_, t = call('POST', '/types', {
    'name': 'OPEN Type',
    'fields': [
        {'label': 'Storage', 'type': 'choice', 'options': [], 'filterable': True},
        {'label': 'Colour', 'type': 'choice', 'options': [],
         'variantForming': True, 'filterable': True},
        {'label': 'Grade', 'type': 'choice', 'options': ['A', 'B']},
    ]})
TID = t['data']['id']
fields = {f['key']: f for f in t['data']['fields']}
ck('an open choice field is accepted with no options',
   not fields.get('storage', {}).get('options'), t['data'].get('fields'))
ck('a fixed list still keeps its options', fields.get('grade', {}).get('options') == ['A', 'B'],
   fields.get('grade'))

_, c = call('POST', '/categories', {'name': 'OPEN Cat', 'typeId': TID,
            'commerce': {'pricing': {'model': 'fixed'}, 'availability': {'model': 'none'}}})
CID = c['data']['id']

# ----------------------------------------------------------- vocabulary
print('\n[Vocabulary endpoint]')
code, v = call('GET', '/types/%s/vocabulary' % TID)
ck('the vocabulary endpoint answers', code == 200, v.get('message'))
ck('it lists the open fields', set(v.get('data', {})) == {'storage', 'colour'}, v.get('data'))
ck('and leaves out the fixed one', 'grade' not in v.get('data', {}), v.get('data'))
ck("it holds only this field's values, not every value on the same documents",
   all(x not in vals(v['data']['storage']) for x in ('Blue', 'Red', 'A')), v['data'])

# ------------------------------------------------- product-level open field
print('\n[Product-level open field]')
code, p1 = call('POST', '/products', {
    'sku': 'OPEN-1', 'name': 'First', 'categoryIds': [CID],
    'attributes': [{'key': 'storage', 'value': '128GB'}, {'key': 'grade', 'value': 'a'}],
    'items': [{'attributes': [{'key': 'colour', 'value': 'Blue'}]}]})
ck('a free-typed value is accepted', code == 201, p1.get('message'))
ck('and stored as typed', attrs_of(p1['data']).get('storage') == '128GB', p1['data'].get('attributes'))
ck('the fixed field still snaps to its declared casing',
   attrs_of(p1['data']).get('grade') == 'A', p1['data'].get('attributes'))

code, bad = call('POST', '/products', {
    'sku': 'OPEN-BAD', 'name': 'Bad', 'categoryIds': [CID],
    'attributes': [{'key': 'grade', 'value': 'Z'}],
    'items': [{'attributes': [{'key': 'colour', 'value': 'Blue'}]}]})
ck('a fixed field still rejects an unlisted value', code == 422, bad.get('message'))

# The regression this suite exists for: the second product types the same
# storage differently and must be snapped onto the first spelling.
code, p2 = call('POST', '/products', {
    'sku': 'OPEN-2', 'name': 'Second', 'categoryIds': [CID],
    'attributes': [{'key': 'storage', 'value': '128gb'}],
    'items': [{'attributes': [{'key': 'colour', 'value': 'blue'}]}]})
ck('a second product saves', code == 201, p2.get('message'))
ck('a product-level open value snaps to the spelling already in use',
   attrs_of(p2['data']).get('storage') == '128GB', p2['data'].get('attributes'))
ck('a variant-forming open value snaps too',
   attrs_of(p2['data']['items'][0]).get('colour') == 'Blue',
   p2['data']['items'][0].get('attributes'))

_, v = call('GET', '/types/%s/vocabulary' % TID)
ck('the vocabulary now offers what was typed', '128GB' in vals(v['data']['storage']), v['data'])
ck('and only one spelling of it', '128gb' not in vals(v['data']['storage']), v['data'])
ck("a fixed field's values never leak into an open one",
   'A' not in vals(v['data']['storage']) and 'B' not in vals(v['data']['storage']), v['data'])
ck("nor do another field's",
   'Blue' not in vals(v['data']['storage']), v['data'])

# a genuinely new value is still allowed through
code, p3 = call('POST', '/products', {
    'sku': 'OPEN-3', 'name': 'Third', 'categoryIds': [CID],
    'attributes': [{'key': 'storage', 'value': '256GB'}],
    'items': [{'attributes': [{'key': 'colour', 'value': 'Red'}]}]})
ck('a genuinely new value is still accepted', code == 201, p3.get('message'))
_, v = call('GET', '/types/%s/vocabulary' % TID)
ck('and joins the vocabulary',
   '256GB' in vals(v['data']['storage']) and '128GB' in vals(v['data']['storage']), v['data'])
ck('each value carries how many records use it',
   count_of(v['data']['storage'], '128GB') == 2, v['data']['storage'])
ck('the most used value comes first',
   vals(v['data']['storage'])[0] == '128GB', v['data']['storage'])
ck('the colour vocabulary is the colours only',
   set(vals(v['data']['colour'])) >= {'Blue', 'Red'} and '128GB' not in vals(v['data']['colour']),
   v['data'])

# ------------------------------------------------- promoting to a fixed list
print()
print('[Promote an open list]')

# The way out of an open list: take what has accumulated and declare it.
code, up = call('PATCH', '/types/%s/fields/storage' % TID, {'options': ['128GB', '256GB']})
ck('an open field can be given a fixed list', code == 200, up.get('message'))
promoted = next(f for f in up['data']['fields'] if f['key'] == 'storage')
ck('the list is stored', promoted['options'] == ['128GB', '256GB'], promoted)
ck('it is no longer open', bool(promoted['options']), promoted)
ck('the other flags survive the promotion',
   promoted['filterable'] is True and promoted['variantForming'] is False, promoted)

_, v = call('GET', '/types/%s/vocabulary' % TID)
ck('a promoted field drops out of the vocabulary', 'storage' not in v['data'], v['data'])
ck('the still-open one stays', 'colour' in v['data'], v['data'])

# Existing products keep their values — the list was built from them.
_, reread = call('GET', '/products/' + p1['data']['id'])
ck('products keep the value they already had',
   attrs_of(reread['data']).get('storage') == '128GB', reread['data'].get('attributes'))

# And from now on the list is enforced.
code, r = call('POST', '/products', {
    'sku': 'OPEN-4', 'name': 'Fourth', 'categoryIds': [CID],
    'attributes': [{'key': 'storage', 'value': '1TB'}],
    'items': [{'attributes': [{'key': 'colour', 'value': 'Blue'}]}]})
ck('a value outside the new list is now refused', code == 422, r.get('message'))
ck('the message lists what is allowed', '128GB' in r.get('message', ''), r.get('message'))

code, r = call('POST', '/products', {
    'sku': 'OPEN-5', 'name': 'Fifth', 'categoryIds': [CID],
    'attributes': [{'key': 'storage', 'value': '256gb'}],
    'items': [{'attributes': [{'key': 'colour', 'value': 'Blue'}]}]})
ck('a listed value still snaps to the declared casing',
   code == 201 and attrs_of(r['data']).get('storage') == '256GB', r.get('message'))
if code == 201:
    call('DELETE', '/products/' + r['data']['id'])

# Reversible: clearing the options opens it again.
code, back = call('PATCH', '/types/%s/fields/storage' % TID, {'options': []})
opened = next(f for f in back['data']['fields'] if f['key'] == 'storage')
ck('clearing the options makes it open again', code == 200 and not opened.get('options'), opened)
_, v = call('GET', '/types/%s/vocabulary' % TID)
ck('and it returns to the vocabulary', 'storage' in v['data'], v['data'])

# ---------------------------------------------------------------- cleanup
for pid in [d['data']['id'] for d in (p1, p2, p3) if d.get('data', {}).get('id')]:
    call('DELETE', '/products/' + pid)
call('DELETE', '/categories/' + CID)
call('DELETE', '/types/' + TID)

print()
print('PASSED %d   FAILED %d' % (len(P), len(F)))
for f in F:
    print('  - ' + f)
sys.exit(1 if F else 0)
