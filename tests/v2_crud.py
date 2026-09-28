# -*- coding: utf-8 -*-
"""
Catalogue v2 — every edit, delete and restore the UI can reach.

CLEARS THE ENTIRE V2 CATALOGUE before it runs — its assertions depend on an
exact starting state. Run it through `tests/run_tests.py`, which points a
backend at a throwaway database first. Never aim it at a server holding data
you want to keep.
"""
import os
import json, urllib.request, urllib.error, sys

API = os.environ.get('TEST_API', 'http://localhost:5099')
B = API + '/api/v1/v2'
PASS, FAIL = [], []

r = urllib.request.Request(API + '/api/v1/auth/login',
    data=json.dumps({'email': 'crud-tmp@example.com', 'password': 'Crud!12345'}).encode(),
    headers={'Content-Type': 'application/json'})
TOK = json.load(urllib.request.urlopen(r))['data']['token']


def call(m, p, b=None):
    d = json.dumps(b).encode() if b is not None else None
    q = urllib.request.Request(B + p, data=d, method=m,
                               headers={'Content-Type': 'application/json',
                                        'Authorization': 'Bearer ' + TOK})
    try:
        resp = urllib.request.urlopen(q)
        return resp.getcode(), json.load(resp)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {'raw': raw[:300]}


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(name)
    print(('  OK   ' if cond else '  FAIL ') + name + ('' if cond else '  <- ' + str(detail)[:250]))


# cleanup
_, pl = call('GET', '/products?limit=200&includeDeleted=true')
for row in (pl.get('data') or []):
    call('DELETE', '/products/' + row['id'])
_, cl = call('GET', '/charges?includeDeleted=true')
for row in (cl.get('data') or []):
    call('DELETE', '/charges/' + row['id'])
_, cats = call('GET', '/categories?includeDeleted=true')
for row in sorted(cats.get('data') or [], key=lambda x: -x.get('depth', 0)):
    call('DELETE', '/categories/' + row['id'])
_, ts = call('GET', '/types?limit=200&includeDeleted=true')
for row in (ts.get('data') or []):
    call('DELETE', '/types/' + row['id'])

print('=' * 70)
print('EDIT / DELETE / RESTORE  —  every UI control')
print('=' * 70)

# ------------------------------------------------------------- fixtures
_, t = call('POST', '/types', {'name': 'CRUD Type', 'fields': [
    {'label': 'Size', 'type': 'choice', 'options': ['S', 'M', 'L'],
     'variantForming': True, 'filterable': True},
    {'label': 'Material', 'type': 'text'}]})
TYPE = t['data']['id']
_, c = call('POST', '/categories', {'name': 'CRUD Cat', 'typeId': TYPE,
    'commerce': {'pricing': {'model': 'fixed'}, 'availability': {'model': 'quantity'}}})
CAT = c['data']['id']
_, p = call('POST', '/products', {'sku': 'CRUD-1', 'name': 'CRUD Product', 'status': 'active',
    'categoryIds': [CAT], 'items': [
        {'attributes': [{'key': 'size', 'value': 'S'}], 'price': 100, 'stock': 5},
        {'attributes': [{'key': 'size', 'value': 'M'}], 'price': 120, 'stock': 3}]})
PROD = p['data']['id']
ITEM = p['data']['items'][0]['id']
ITEM2 = p['data']['items'][1]['id']

print('\n[Setup — type]')
code, r = call('PATCH', '/types/' + TYPE, {'name': 'CRUD Type Renamed', 'description': 'edited'})
check('Rename button: type name + description update',
      code == 200 and r['data']['name'] == 'CRUD Type Renamed', r.get('message'))

print('\n[Setup — fields]')
code, r = call('PATCH', '/types/%s/fields/size' % TYPE, {'label': 'Size (EU)'})
check('field Edit: label renames without touching the key',
      code == 200 and next(f for f in r['data']['fields'] if f['key'] == 'size')['label'] == 'Size (EU)', r)
# S is used by an item, so removing it must be refused; L is unused, so
# removing L would legitimately succeed and is not the case under test.
code, r = call('PATCH', '/types/%s/fields/size' % TYPE, {'options': ['M', 'L']})
check('field Edit: removing an in-use option is refused', code == 409, r.get('message'))
code, r = call('GET', '/types/' + TYPE)
size = next(f for f in r['data']['fields'] if f['key'] == 'size')
check('field Edit: a refused option change leaves the field untouched',
      size['options'] == ['S', 'M', 'L'] and size['variantForming'] is True, size)
code, r = call('PATCH', '/types/%s/fields/material' % TYPE, {'deprecated': True})
check('field Retire button: marks deprecated', code == 200, r.get('message'))
code, r = call('PATCH', '/types/%s/fields/material' % TYPE, {'deprecated': False})
check('field Retire button: toggles back', code == 200, r.get('message'))
call('POST', '/types/%s/fields' % TYPE, {'label': 'Scratch', 'type': 'text'})
code, r = call('DELETE', '/types/%s/fields/scratch' % TYPE)
check('field Delete: an unused field goes outright, without touching the type',
      code == 200 and 'nothing was using it' in r.get('message', ''), r.get('message'))
code, r = call('GET', '/types/' + TYPE)
check('field Delete: the type and its other fields survive',
      len(r['data']['fields']) == 2, [f['key'] for f in r['data']['fields']])

print('\n[Product details — item]')
code, r = call('PATCH', '/products/%s/items/%s' % (PROD, ITEM),
               {'description': 'edited via the item popup', 'status': 'active'})
check('item Edit: description saves', code == 200 and r['data']['description'] == 'edited via the item popup', r)
code, r = call('PATCH', '/products/%s/items/%s' % (PROD, ITEM),
               {'attributes': [{'key': 'size', 'value': 'L'}]})
check('item Edit: attributes change and relabel',
      code == 200 and r['data']['valueLabel'] == 'L', r.get('data', {}).get('valueLabel'))
code, r = call('PATCH', '/products/%s/items/%s' % (PROD, ITEM),
               {'attributes': [{'key': 'size', 'value': 'M'}]})
check('item Edit: clashing with a sibling is refused', code == 409, r.get('message'))

print('\n[Product details — prices]')
code, r = call('GET', '/prices?itemId=' + ITEM)
check('Prices popup: lists the item price records', code == 200 and len(r['data']) >= 1, r.get('data'))
PRICE = r['data'][0]['id']
code, r = call('PATCH', '/prices/' + PRICE, {'amount': 149})
check('Prices popup: Edit changes the amount', code == 200 and r['data']['amount'] == 149, r.get('data'))
code, r = call('POST', '/prices', {'itemId': ITEM, 'amount': 85, 'priceListId': 'b2b', 'minQuantity': 11})
check('Prices popup: Add a b2b quantity band', code == 201, r.get('message'))
BAND = r['data']['id']
code, r = call('GET', '/prices?itemId=' + ITEM)
check('Prices popup: both rows listed', len(r['data']) == 2, len(r['data']))
code, r = call('DELETE', '/prices/' + BAND)
check('Prices popup: Delete is soft', code == 200 and r['data']['is_deleted'] is True, r.get('data'))
code, r = call('POST', '/prices/%s/restore' % BAND)
check('Prices popup: a deleted price can be restored', code == 200, r.get('message'))
call('DELETE', '/prices/' + BAND)

print('\n[Product details — availability]')
code, r = call('GET', '/availability?itemId=' + ITEM)
check('Availability popup: lists the rows', code == 200 and len(r['data']) >= 1, r.get('data'))
AV = r['data'][0]['id']
code, r = call('POST', '/availability', {'itemId': ITEM, 'strategy': 'quantity',
                                         'locationId': 'default', 'onHand': 42})
check('Availability popup: Edit upserts rather than duplicating',
      code == 201 and r['data']['onHand'] == 42, r.get('data'))
code, r = call('GET', '/availability?itemId=' + ITEM)
check('Availability popup: still one default-location row', len(r['data']) == 1, len(r['data']))
code, r = call('POST', '/availability', {'itemId': ITEM, 'strategy': 'quantity',
                                         'locationId': 'shop-2', 'onHand': 7})
check('Availability popup: a second location is its own row', code == 201, r.get('message'))
code, r = call('GET', '/items/%s/availability' % ITEM)
check('Availability popup: locations sum (42 + 7)',
      r['data']['detail']['onHand'] == 49, r['data'].get('detail'))
code, r = call('DELETE', '/availability/' + AV)
check('Availability popup: Delete is soft', code == 200 and r['data']['is_deleted'] is True, r.get('data'))
code, r = call('POST', '/availability/%s/restore' % AV)
check('Availability popup: restore works', code == 200, r.get('message'))

print('\n[Product details — delete item]')
code, r = call('DELETE', '/products/%s/items/%s' % (PROD, ITEM2))
check('item Delete: removes just that item', code == 200 and r['data']['is_deleted'] is True, r.get('data'))
code, r = call('GET', '/products/' + PROD)
check('item Delete: the product and its other item survive',
      len(r['data']['items']) == 1, len(r['data'].get('items', [])))
code, r = call('DELETE', '/products/%s/items/%s' % (PROD, ITEM))
check('item Delete: the last item is refused', code == 409, r.get('message'))

print('\n[Show deleted + Restore]')
code, r = call('GET', '/products?limit=50&includeDeleted=true')
check('Products: includeDeleted is accepted on the GET', code == 200, r.get('message'))
code, r = call('POST', '/products/search', {'includeDeleted': True, 'limit': 50})
check('Products: includeDeleted is accepted on the search', code == 200, r.get('message'))

call('DELETE', '/products/' + PROD)
code, r = call('POST', '/products/search', {'limit': 50})
check('Products: a deleted product is hidden by default',
      not any(x['id'] == PROD for x in r['data']), [x['id'] for x in r['data']])
code, r = call('POST', '/products/search', {'limit': 50, 'includeDeleted': True})
row = next((x for x in r['data'] if x['id'] == PROD), None)
check('Products: Show deleted surfaces it, flagged', row and row['is_deleted'] is True, row)
code, r = call('POST', '/products/%s/restore' % PROD)
check('Products: Restore brings it back with its items',
      code == 200 and len(r['data']['items']) >= 1, r.get('message'))

_, ch = call('POST', '/charges', {'name': 'CRUD Fee', 'scope': {'level': 'category', 'refId': CAT},
                                  'basis': 'fixed', 'amount': 500, 'required': True})
CHG = ch['data']['id']
code, r = call('PATCH', '/charges/' + CHG, {'amount': 750})
check('Charges: Edit changes the amount', code == 200 and r['data']['amount'] == 750, r.get('data'))
call('DELETE', '/charges/' + CHG)
code, r = call('GET', '/charges')
check('Charges: deleted is hidden by default',
      not any(x['id'] == CHG for x in r['data']), [x['id'] for x in r['data']])
code, r = call('GET', '/charges?includeDeleted=true')
check('Charges: Show deleted surfaces it',
      any(x['id'] == CHG and x['is_deleted'] for x in r['data']), r.get('data'))
code, r = call('POST', '/charges/%s/restore' % CHG)
check('Charges: Restore works', code == 200, r.get('message'))

_, sub = call('POST', '/categories', {'name': 'CRUD Sub', 'parentId': CAT})
SUB = sub['data']['id']
call('DELETE', '/categories/' + SUB)
code, r = call('GET', '/categories')
check('Categories: deleted is hidden by default',
      not any(x['id'] == SUB for x in r['data']), [x['name'] for x in r['data']])
code, r = call('GET', '/categories?includeDeleted=true')
check('Categories: Show deleted surfaces it',
      any(x['id'] == SUB and x['is_deleted'] for x in r['data']), r.get('data'))
code, r = call('POST', '/categories/%s/restore' % SUB)
check('Categories: Restore works', code == 200, r.get('message'))

print()
print('=' * 70)
print('PASSED %d   FAILED %d' % (len(PASS), len(FAIL)))
if FAIL:
    print('\nFailures:')
    for f in FAIL:
        print('  - ' + f)
print('=' * 70)
sys.exit(1 if FAIL else 0)
