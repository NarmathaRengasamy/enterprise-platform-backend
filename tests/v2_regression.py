# -*- coding: utf-8 -*-
"""
Catalogue v2 — end-to-end regression suite.

CLEARS THE ENTIRE V2 CATALOGUE before it runs — its assertions depend on an
exact starting state. Run it through `tests/run_tests.py`, which points a
backend at a throwaway database first. Never aim it at a server holding data
you want to keep.
"""
import os
import json, re, urllib.request, urllib.error, sys

API = os.environ.get('TEST_API', 'http://localhost:5099')
B = API + '/api/v1/v2'
TOK = None
PASS = []
FAIL = []
UUID_RX = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(B + path, data=data, method=method,
                               headers={'Content-Type': 'application/json',
                                        'Authorization': 'Bearer ' + TOK})
    try:
        resp = urllib.request.urlopen(r)
        return resp.getcode(), json.load(resp)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {'raw': raw[:400]}


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(name)
    print(('  OK   ' if cond else '  FAIL ') + name + ('' if cond else '  <- ' + str(detail)[:300]))


def login():
    global TOK
    r = urllib.request.Request(API + '/api/v1/auth/login',
                               data=json.dumps({'email': 'v2tester@example.com',
                                                'password': 'V2tester!2345'}).encode(),
                               headers={'Content-Type': 'application/json'})
    TOK = json.load(urllib.request.urlopen(r))['data']['token']


print('=' * 70)
print('CATALOGUE V2 SMOKE TEST  —  UUID ids + soft delete')
print('=' * 70)
login()


def cleanup():
    """Soft-delete anything a previous run left behind, so SKUs are free."""
    _, pl = call('GET', '/products?limit=200')
    for row in (pl.get('data') or []):
        if row['sku'].startswith(('SMOKE-', 'DUP-PROBE')):
            call('DELETE', '/products/' + row['id'])
    _, cl = call('GET', '/charges')
    for row in (cl.get('data') or []):
        call('DELETE', '/charges/' + row['id'])
    _, cats = call('GET', '/categories')
    for row in sorted(cats.get('data') or [], key=lambda x: -x.get('depth', 0)):
        if row['name'].startswith('Smoke'):
            call('DELETE', '/categories/' + row['id'])
    _, ts = call('GET', '/types?limit=200')
    for row in (ts.get('data') or []):
        if row['name'].startswith(('Smoke', 'SKU probe')):
            call('DELETE', '/types/' + row['id'])


cleanup()

# ------------------------------------------------------------ 1. TYPES
print('\n[1] Product types and field definitions')

code, r = call('POST', '/types', {
    'name': 'Smoke Phone',
    'fields': [
        {'label': 'Colour', 'type': 'choice', 'options': ['Blue', 'Green'],
         'variantForming': True, 'filterable': True},
        {'label': 'Storage', 'type': 'choice', 'options': ['128GB', '256GB'],
         'variantForming': True, 'filterable': True},
        {'label': 'Screen', 'type': 'choice', 'options': ['Touch', 'Button'],
         'variantForming': True},
        {'label': 'Warranty months', 'type': 'number'},
    ]})
check('create a type with 3 variant axes', code == 201, r)
PHONE = r['data']['id']
check('the type id is a v4 UUID', bool(UUID_RX.match(PHONE)), PHONE)
check('a new type is not deleted', r['data'].get('is_deleted') is False, r['data'].get('is_deleted'))
keys = [f['key'] for f in r['data']['fields']]
check('labels become stable keys', keys == ['colour', 'storage', 'screen', 'warranty_months'], keys)

code, r = call('POST', '/types', {'id': 'I-PICKED-THIS', 'name': 'Smoke Ignored Id',
                                  'fields': [{'label': 'X', 'type': 'text'}]})
check('a client-supplied id is ignored, not honoured',
      code == 201 and r['data']['id'] != 'I-PICKED-THIS' and UUID_RX.match(r['data']['id']),
      r['data'].get('id'))
call('DELETE', '/types/' + r['data']['id'])

code, r = call('POST', '/types', {'name': 'Bad',
                                  'fields': [{'label': 'Notes', 'type': 'text',
                                              'variantForming': True}]})
check('reject a free-text variant axis', code == 422, r.get('message'))

# A choice field with no options is now legal: it is an OPEN list, and the
# product author supplies the values. This replaces the old rejection.
code, r = call('POST', '/types', {'name': 'Smoke Open', 'fields': [
    {'label': 'Finish', 'type': 'choice', 'variantForming': True, 'filterable': True}]})
check('a choice field with no options is accepted as an open list', code == 201, r.get('message'))
OPEN_T = r['data']['id'] if code == 201 else None
if OPEN_T:
    f = r['data']['fields'][0]
    check('it is stored with no options', not f.get('options'), f)
    check('and it still forms variants', f['variantForming'] is True, f)

    _, oc = call('POST', '/categories', {'name': 'Smoke Open Cat', 'typeId': OPEN_T,
                 'commerce': {'pricing': {'model': 'fixed'}, 'availability': {'model': 'none'}}})
    OPEN_C = oc['data']['id']

    code, r = call('POST', '/products/matrix', {
        'typeId': OPEN_T, 'sku': 'SMOKE-OPEN',
        'selection': {'finish': ['Matte', 'Gloss', 'Satin']}})
    check('the matrix accepts values the type never declared',
          r.get('data', {}).get('count') == 3, r.get('data'))

    code, r = call('POST', '/products', {
        'sku': 'SMOKE-OPEN', 'name': 'Smoke Open Product', 'status': 'active',
        'categoryIds': [OPEN_C],
        'items': [{'attributes': [{'key': 'finish', 'value': v}]}
                  for v in ('Matte', 'Gloss', 'Satin')]})
    check('a product saves with free-typed values', code == 201, r.get('message'))
    OPEN_P = r['data']['id'] if code == 201 else None

    # the casing guarantee has to survive without a declared list
    code, r = call('POST', '/products', {
        'sku': 'SMOKE-OPEN-2', 'name': 'Smoke Open Two', 'status': 'active',
        'categoryIds': [OPEN_C],
        'items': [{'attributes': [{'key': 'finish', 'value': v}]}
                  for v in ('MATTE', 'gloss', 'SaTiN')]})
    check('a second product saves with different casing', code == 201, r.get('message'))
    OPEN_P2 = r['data']['id'] if code == 201 else None
    if OPEN_P2:
        got = sorted(a['value'] for i in r['data']['items'] for a in i['attributes'])
        check('casing snaps to the spellings already in use',
              got == ['Gloss', 'Matte', 'Satin'], got)

    code, r = call('POST', '/products/search', {'categoryId': OPEN_C, 'facets': True})
    facet = next((f for f in r.get('facets', []) if f['key'] == 'finish'), None)
    check('the facet shows 3 values, not 6', facet and len(facet['values']) == 3, facet)

    # an open field can be locked down later
    code, r = call('PATCH', '/types/%s/fields/finish' % OPEN_T,
                   {'options': ['Matte', 'Gloss', 'Satin']})
    check('an open field can be given a fixed list later', code == 200, r.get('message'))
    code, r = call('POST', '/products', {
        'sku': 'SMOKE-OPEN-3', 'name': 'Smoke Open Three', 'typeId': OPEN_T,
        'items': [{'attributes': [{'key': 'finish', 'value': 'Brushed'}]}]})
    check('once locked, an undeclared value is refused', code == 422, r.get('message'))

    for pid in [x for x in (OPEN_P, OPEN_P2) if x]:
        call('DELETE', '/products/' + pid)
    call('DELETE', '/categories/' + OPEN_C)
    call('DELETE', '/types/' + OPEN_T)

code, r = call('POST', '/types/%s/fields' % PHONE,
               {'label': 'Colour', 'type': 'choice', 'options': ['Red']})
check('reject a duplicate field key', code == 409, r.get('message'))

# ------------------------------------------------------- 2. CATEGORIES
print('\n[2] Categories, commerce config and inheritance')

code, r = call('POST', '/categories', {
    'name': 'Smoke Electronics', 'typeId': PHONE,
    'commerce': {'pricing': {'model': 'per_variant', 'currency': 'INR'},
                 'availability': {'model': 'quantity'}}})
check('create a parent category with commerce', code == 201, r)
ELEC = r['data']['id']
check('the category id is a UUID', bool(UUID_RX.match(ELEC)), ELEC)

code, r = call('POST', '/categories', {'name': 'Smoke Phones', 'parentId': ELEC})
check('create a child with no commerce of its own', code == 201, r)
PHONES = r['data']['id']

code, r = call('GET', '/categories/' + PHONES)
check('child inherits the parent commerce model',
      r['data']['effectiveCommerce']['pricing']['model'] == 'per_variant', r)
check('child inherits the parent type', r['data']['effectiveTypeId'] == PHONE, r)
check('inherited field definitions travel with the category',
      len(r['data']['fields']) == 4, r)

code, r = call('PATCH', '/categories/' + ELEC, {'parentId': PHONES})
check('refuse a parent change that would make a cycle', code == 422, r.get('message'))

code, r = call('POST', '/categories', {
    'name': 'Bad slot',
    'commerce': {'pricing': {'model': 'fixed'}, 'availability': {'model': 'time_slot'}}})
check('refuse time_slot with no slotMinutes', code == 422, r.get('message'))

# ---------------------------------------------------------- 3. MATRIX
print('\n[3] Variant matrix')

code, r = call('POST', '/products/matrix', {
    'typeId': PHONE, 'sku': 'SMOKE-IPH11',
    'selection': {'colour': ['Blue', 'Green'], 'storage': ['128GB', '256GB'],
                  'screen': ['Touch', 'Button']}})
check('2 x 2 x 2 produces 8 combinations', r['data']['count'] == 8, r)
first = r['data']['items'][0]
check('matrix derives a SKU per combination',
      first['sku'] == 'SMOKE-IPH11-BLUE-128GB-TOUCH', first.get('sku'))
check('matrix derives display labels',
      first['optionLabel'] == 'Colour / Storage / Screen', first.get('optionLabel'))

# --------------------------------------------------------- 4. PRODUCT
print('\n[4] Product with multi-axis variants')

items = []
for colour in ['Blue', 'Green']:
    for storage in ['128GB', '256GB']:
        for screen in ['Touch', 'Button']:
            items.append({
                'attributes': [{'key': 'colour', 'value': colour},
                               {'key': 'storage', 'value': storage},
                               {'key': 'screen', 'value': screen}],
                'description': '%s %s, %s screen' % (colour, storage, screen.lower()),
                'price': 40000 + (10000 if storage == '256GB' else 0),
                'stock': 5,
            })

code, r = call('POST', '/products', {
    'sku': 'SMOKE-IPH11', 'name': 'Smoke iPhone 11',
    'categoryIds': [PHONES], 'status': 'active',
    'attributes': [{'key': 'warranty_months', 'value': 12}],
    'items': items})
check('create a product with 8 items', code == 201 and len(r['data']['items']) == 8, r)
IPH = r['data']['id']
check('the product id is a UUID', bool(UUID_RX.match(IPH)), IPH)
check('every item id is a UUID too',
      all(UUID_RX.match(i['id']) for i in r['data']['items']),
      [i['id'] for i in r['data']['items']][:2])
check('item SKUs are still human-readable',
      r['data']['items'][0]['sku'].startswith('SMOKE-IPH11-'), r['data']['items'][0]['sku'])
check('price rolls up as a range',
      r['data']['priceFrom'] == 40000 and r['data']['priceTo'] == 50000, r['data'])
check('availability rolls up from the item rows', r['data']['available'] is True,
      r['data']['availabilityLabel'])

code, r = call('POST', '/products', {
    'sku': 'SMOKE-DUP', 'name': 'Dup', 'typeId': PHONE,
    'items': [{'attributes': [{'key': 'colour', 'value': 'Blue'},
                              {'key': 'storage', 'value': '128GB'},
                              {'key': 'screen', 'value': 'Touch'}]},
              {'attributes': [{'key': 'screen', 'value': 'Touch'},
                              {'key': 'storage', 'value': '128GB'},
                              {'key': 'colour', 'value': 'Blue'}]}]})
check('reject a duplicate combination regardless of attribute order', code == 422, r.get('message'))

code, r = call('POST', '/products', {
    'sku': 'SMOKE-BADVAL', 'name': 'Bad', 'typeId': PHONE,
    'items': [{'attributes': [{'key': 'colour', 'value': 'Turquoise'},
                              {'key': 'storage', 'value': '128GB'},
                              {'key': 'screen', 'value': 'Touch'}]}]})
check('reject a value outside the declared options', code == 422, r.get('message'))

code, r = call('POST', '/products', {
    'sku': 'SMOKE-BADKEY', 'name': 'Bad', 'typeId': PHONE,
    'attributes': [{'key': 'made_up_field', 'value': 'x'}]})
check('reject an undeclared attribute key', code == 422, r.get('message'))

code, r = call('POST', '/products', {
    'sku': 'SMOKE-CASE', 'name': 'Case test', 'typeId': PHONE,
    'items': [{'attributes': [{'key': 'colour', 'value': 'BLUE'},
                              {'key': 'storage', 'value': '128gb'},
                              {'key': 'screen', 'value': 'touch'}]}]})
stored = r['data']['items'][0]['attributes']
check('values are stored in the declared casing',
      code == 201 and [a['value'] for a in stored] == ['Blue', '128GB', 'Touch'], stored)
CASE = r['data']['id']

# ---------------------------------------------------- 5. SEARCH/FACETS
print('\n[5] Filtering and facets')

code, r = call('POST', '/products/search', {
    'attributes': {'colour': ['Blue'], 'storage': ['256GB']}, 'facets': True})
check('multi-axis filter returns the product', r['total'] >= 1, r['total'])
matched = r['data'][0]['items']
check('filter narrows to the matching items only', len(matched) == 2, len(matched))
check('the narrowed items really are Blue/256GB',
      all(any(a['key'] == 'colour' and a['value'] == 'Blue' for a in i['attributes'])
          and any(a['key'] == 'storage' and a['value'] == '256GB' for a in i['attributes'])
          for i in matched), matched)
facets = {f['key']: f for f in r.get('facets', [])}
check('facets carry counts',
      all('count' in v for v in facets.get('colour', {}).get('values', [])), facets.get('colour'))

code, r = call('POST', '/products/search', {'priceMin': 45000})
check('price floor filter uses the item range', r['total'] >= 1, r['total'])

code, r = call('POST', '/products/search', {'search': 'Smoke iPhone'})
check('text search finds the product', r['total'] >= 1, r['total'])

# ------------------------------------------ 6. PRICELESS + CHARGES
print('\n[6] A product with no price, plus required charges')

code, r = call('POST', '/types', {
    'name': 'Smoke Vehicle',
    'fields': [{'label': 'Trim', 'type': 'choice', 'options': ['Base', 'Top'],
                'variantForming': True}]})
VEH = r['data']['id']

code, r = call('POST', '/categories', {
    'name': 'Smoke Cars', 'typeId': VEH,
    'commerce': {'pricing': {'model': 'on_request', 'label': 'Ex-showroom'},
                 'availability': {'model': 'lead_time'}}})
CARS = r['data']['id']
check('create an on_request / lead_time category', code == 201, r)

code, r = call('POST', '/products', {
    'sku': 'SMOKE-CAR', 'name': 'Smoke Sedan', 'categoryIds': [CARS], 'status': 'active',
    'items': [{'attributes': [{'key': 'trim', 'value': 'Top'}], 'leadDays': 42}]})
check('create a car with no price at all', code == 201, r)
CAR = r['data']['id']
car_item = r['data']['items'][0]['id']
check('an unpriced product reports no price, not zero', r['data']['priceFrom'] is None, r['data'])
check('an unpriced product is NOT reported as out of stock', r['data']['available'] is True,
      r['data']['availabilityLabel'])
check('lead time renders as a human phrase', 'week' in r['data']['availabilityLabel'],
      r['data']['availabilityLabel'])

_, reg = call('POST', '/charges', {'name': 'Registration', 'label': 'RTO registration',
                                   'scope': {'level': 'category', 'refId': CARS},
                                   'basis': 'fixed', 'amount': 15000, 'required': True})
check('the charge id is a UUID', bool(UUID_RX.match(reg['data']['id'])), reg['data']['id'])
call('POST', '/charges', {'name': 'GST', 'label': 'GST 18%',
                          'scope': {'level': 'category', 'refId': CARS},
                          'basis': 'percent', 'percent': 18, 'required': True})
code, coat = call('POST', '/charges', {'name': 'Ceramic coating',
                                       'scope': {'level': 'product', 'refId': CAR},
                                       'basis': 'fixed', 'amount': 25000, 'required': False})
check('create category and product level charges', code == 201, coat)

code, r = call('POST', '/charges', {'name': 'Broken', 'scope': {'level': 'item', 'refId': car_item},
                                    'basis': 'percent', 'required': True})
check('reject a percent charge with no percent', code == 400, r.get('message'))

code, r = call('GET', '/items/%s/charges' % car_item)
d = r['data']
check('base is null for an on_request item', d['base'] is None, d)
req = {c['name']: c for c in d['required']}
check('the fixed required charge is still computed', req['Registration']['amount'] == 15000, req)
check('a percent charge with no base reports why instead of showing zero',
      req['GST']['amount'] is None and 'confirmed' in req['GST'].get('note', ''), req.get('GST'))
check('total is null rather than partial', d['totalRequired'] is None, d['totalRequired'])
check('a note explains the charges apply on top of the quote', 'on top' in (d['note'] or ''), d['note'])
check('the optional charge is separated out',
      [c['name'] for c in d['optional']] == ['Ceramic coating'], d['optional'])
check('each charge says where it was inherited from',
      req['Registration']['source']['level'] == 'category', req['Registration'])

# -------------------------------------- 7. CHARGE MATHS ON A PRICE
print('\n[7] Charge arithmetic, including tax on a fee')

_, r = call('POST', '/types', {'name': 'Smoke Room',
                               'fields': [{'label': 'Bed', 'type': 'choice',
                                           'options': ['King'], 'variantForming': True}]})
ROOMT = r['data']['id']
_, r = call('POST', '/categories', {
    'name': 'Smoke Hotel', 'typeId': ROOMT,
    'commerce': {'pricing': {'model': 'per_time', 'unit': 'night'},
                 'availability': {'model': 'capacity_per_date'}}})
HOTEL = r['data']['id']
code, r = call('POST', '/products', {
    'sku': 'SMOKE-ROOM', 'name': 'Smoke Deluxe Room', 'status': 'active',
    'categoryIds': [HOTEL],
    'items': [{'attributes': [{'key': 'bed', 'value': 'King'}], 'price': 10000}]})
check('create a priced hotel room', code == 201, r)
ROOM = r['data']['id']
room_item = r['data']['items'][0]['id']

call('POST', '/charges', {'name': 'Service charge', 'scope': {'level': 'category', 'refId': HOTEL},
                          'basis': 'percent', 'percent': 10, 'percentOf': 'base', 'required': True})
call('POST', '/charges', {'name': 'Breakfast', 'scope': {'level': 'category', 'refId': HOTEL},
                          'basis': 'per_unit', 'amount': 500, 'required': False})

code, r = call('GET', '/items/%s/charges?units=3' % room_item)
d = r['data']
req = {c['name']: c for c in d['required']}
opt = {c['name']: c for c in d['optional']}
check('base price resolves', d['base'] == 10000, d['base'])
check('a percent-of-base charge computes', req['Service charge']['amount'] == 1000, req)
check('total = base + required charges', d['totalRequired'] == 11000, d['totalRequired'])
check('a per_unit optional charge multiplies by units (500 x 3)',
      opt['Breakfast']['amount'] == 1500, opt)

call('POST', '/charges', {'name': 'GST', 'scope': {'level': 'product', 'refId': ROOM},
                          'basis': 'percent', 'percent': 18,
                          'percentOf': 'base_plus_charges', 'required': True})
code, r = call('GET', '/items/%s/charges' % room_item)
req = {c['name']: c for c in r['data']['required']}
check('percentOf base_plus_charges taxes the fee too (18% of 11000)',
      req['GST']['amount'] == 1980, req.get('GST'))

_, waive = call('POST', '/charges', {'name': 'Service charge',
                                     'scope': {'level': 'item', 'refId': room_item},
                                     'basis': 'fixed', 'amount': 0, 'required': True})
code, r = call('GET', '/items/%s/charges' % room_item)
req = {c['name']: c for c in r['data']['required']}
check('an item-level charge overrides the category one of the same name',
      req['Service charge']['amount'] == 0, req.get('Service charge'))

# ----------------------------------------------------- 8. AVAILABILITY
print('\n[8] Availability strategies')

code, r = call('POST', '/products/search', {'categoryId': PHONES})
phone_item = r['data'][0]['items'][0]['id']

code, r = call('GET', '/items/%s/availability' % phone_item)
check('quantity strategy reports a count', r['data']['label'] == '5 in stock', r['data'])

code, r = call('POST', '/availability/adjust', {'itemId': phone_item, 'delta': -2})
check('a stock decrement applies', r['data']['onHand'] == 3, r['data'])

code, r = call('POST', '/availability/adjust', {'itemId': phone_item, 'delta': -99})
check('overselling is refused with a 409', code == 409, r.get('message'))

code, r = call('GET', '/items/%s/availability' % phone_item)
check('the refused decrement did not change the count',
      r['data']['detail']['onHand'] == 3, r['data'])

code, r = call('POST', '/availability', {'itemId': room_item, 'strategy': 'capacity_per_date',
                                         'date': '2026-10-14', 'capacity': 2})
check('create a dated capacity row', code == 201, r)
check('the availability id is a UUID', bool(UUID_RX.match(r['data']['id'])), r['data']['id'])

code, r = call('GET', '/items/%s/availability?date=2026-10-14' % room_item)
check('capacity_per_date reports what is left on the date',
      r['data']['label'] == '2 left on 2026-10-14', r['data'])

code, r = call('GET', '/items/%s/availability?date=2026-10-20' % room_item)
check('an unconfigured date is not available', r['data']['available'] is False, r['data'])

call('POST', '/availability', {'itemId': room_item, 'strategy': 'capacity_per_date',
                               'date': '2026-10-14', 'capacity': 4})
code, r = call('GET', '/availability?itemId=%s&date=2026-10-14' % room_item)
check('re-posting a date updates the row instead of stacking a second one',
      len(r['data']) == 1 and r['data'][0]['capacity'] == 4, r['data'])

code, r = call('POST', '/availability', {'itemId': room_item, 'strategy': 'quantity'})
check('reject a quantity row with no onHand', code == 400, r.get('message'))

# --------------------------------------------------- 9. SLOTS/BOOKINGS
print('\n[9] Time slots and bookings')

_, r = call('POST', '/types', {'name': 'Smoke Facility',
                               'fields': [{'label': 'Coaching', 'type': 'choice',
                                           'options': ['With coach', 'Without coach'],
                                           'variantForming': True}]})
FAC = r['data']['id']
_, r = call('POST', '/categories', {
    'name': 'Smoke Turf', 'typeId': FAC,
    'commerce': {'pricing': {'model': 'per_time', 'unit': 'hour'},
                 'availability': {'model': 'time_slot', 'slotMinutes': 60}}})
TURFC = r['data']['id']
code, r = call('POST', '/products', {
    'sku': 'SMOKE-TURF', 'name': 'Smoke Turf A', 'status': 'active',
    'categoryIds': [TURFC],
    'items': [{'attributes': [{'key': 'coaching', 'value': 'With coach'}], 'price': 1200},
              {'attributes': [{'key': 'coaching', 'value': 'Without coach'}], 'price': 600}]})
check('create a bookable facility with two variants', code == 201, r)
TURF = r['data']['id']
turf = {i['valueLabel']: i['id'] for i in r['data']['items']}

call('POST', '/availability', {
    'itemId': turf['With coach'], 'strategy': 'time_slot', 'slotMinutes': 60,
    'inchargeId': 'coach-1', 'resourceId': 'court-a',
    'openingHours': {'wed': '09:00-12:00'}})

code, r = call('GET', '/items/%s/slots?date=2026-10-14' % turf['With coach'])
check('slots are generated from the opening hours (09:00-12:00, 60 min = 3)',
      r['data']['total'] == 3, r['data'])
check('all slots start free', r['data']['available'] == 3, r['data'])

code, r = call('GET', '/items/%s/slots?date=2026-10-15' % turf['With coach'])
check('a day with no opening hours yields no slots', r['data']['total'] == 0, r['data'])

code, r = call('POST', '/bookings', {
    'itemId': turf['With coach'], 'inchargeId': 'coach-1', 'resourceId': 'court-a',
    'startsAt': '2026-10-14T10:00:00.000Z', 'endsAt': '2026-10-14T11:00:00.000Z',
    'customerName': 'Smoke Test'})
check('create a booking', code == 201, r)
BOOKING = r['data']['id']
check('the booking id is a UUID', bool(UUID_RX.match(BOOKING)), BOOKING)

code, r = call('POST', '/bookings', {
    'itemId': turf['With coach'], 'inchargeId': 'coach-1', 'resourceId': 'court-a',
    'startsAt': '2026-10-14T10:30:00.000Z', 'endsAt': '2026-10-14T11:30:00.000Z'})
check('an overlapping booking is refused', code == 409, r.get('message'))

code, r = call('GET', '/items/%s/slots?date=2026-10-14' % turf['With coach'])
check('the booked slot is returned but marked unavailable',
      r['data']['total'] == 3 and r['data']['available'] == 2, r['data'])

code, r = call('POST', '/bookings', {
    'itemId': turf['With coach'], 'startsAt': '2026-10-14T11:00:00.000Z',
    'endsAt': '2026-10-14T10:00:00.000Z'})
check('reject a booking that ends before it starts', code == 422, r.get('message'))

code, r = call('POST', '/bookings/%s/cancel' % BOOKING)
check('cancel a booking', code == 200 and r['data']['status'] == 'cancelled', r)

code, r = call('GET', '/items/%s/slots?date=2026-10-14' % turf['With coach'])
check('cancelling frees the slot again', r['data']['available'] == 3, r['data'])

# ------------------------------------------------------- 10. INTEGRITY
print('\n[10] Referential integrity')

code, r = call('DELETE', '/types/' + PHONE)
check('refuse to delete a type still in use', code == 409, r.get('message'))

code, r = call('DELETE', '/categories/' + ELEC)
check('refuse to delete a category with children', code == 409, r.get('message'))

code, r = call('DELETE', '/categories/' + PHONES)
check('refuse to delete a category with products', code == 409, r.get('message'))

code, r = call('PATCH', '/types/%s/fields/colour' % PHONE, {'options': ['Blue']})
check('refuse to remove an option that items still use', code == 409, r.get('message'))

# A field edit must not quietly drop the properties the patch did not mention.
# Spreading a Mongoose subdocument returns its internals, not its values, which
# silently wiped options/variantForming/filterable/required on every edit.
code, r = call('PATCH', '/types/%s/fields/colour' % PHONE, {'label': 'Colour (EU)'})
colour = next(f for f in r['data']['fields'] if f['key'] == 'colour')
check('editing only the label keeps options and the variant flag',
      colour['options'] == ['Blue', 'Green'] and colour['variantForming'] is True, colour)
call('PATCH', '/types/%s/fields/colour' % PHONE, {'label': 'Colour'})

code, r = call('PATCH', '/types/%s/fields/screen' % PHONE, {'deprecated': True})
check('a deprecate-only patch does not fail validation for a missing label',
      code == 200, r.get('message'))
code, r = call('PATCH', '/types/%s/fields/screen' % PHONE, {'deprecated': False})
check('and it toggles back', code == 200, r.get('message'))

code, r = call('DELETE', '/types/%s/fields/warranty_months' % PHONE)
check('a field in use is deprecated, not deleted',
      code == 200 and 'deprecated' in r.get('message', ''), r.get('message'))

call('POST', '/types/%s/fields' % PHONE, {'label': 'Spare', 'type': 'text'})
code, r = call('DELETE', '/types/%s/fields/spare' % PHONE)
check('an unused field is removed outright',
      code == 200 and 'nothing was using it' in r.get('message', ''), r.get('message'))

# --------------------------------------------------- 11. SOFT DELETE
print('\n[11] Soft delete and restore')

code, r = call('GET', '/products/' + CASE)
case_items = [i['id'] for i in r['data']['items']]
case_sku = r['data']['sku']

code, r = call('DELETE', '/products/' + CASE)
check('deleting a product returns the tombstone, not just an id',
      code == 200 and r['data']['is_deleted'] is True, r.get('data'))
check('the deletion is timestamped', bool(r['data'].get('deletedAt')), r['data'].get('deletedAt'))
check('the cascade reports the items that went with it',
      r['data']['itemsDeleted'] == len(case_items), r['data'].get('itemsDeleted'))

code, r = call('GET', '/products/' + CASE)
check('a deleted product 404s on read', code == 404, r.get('message'))

code, r = call('POST', '/products/search', {'search': 'Case test'})
check('a deleted product is gone from search', r['total'] == 0, r['total'])

code, r = call('GET', '/items/%s/availability' % case_items[0])
check('a deleted product\'s items 404 too', code == 404, r.get('message'))

code, r = call('DELETE', '/products/' + CASE)
check('deleting twice is a 404, not a silent re-stamp', code == 404, r.get('message'))

code, r = call('POST', '/products', {
    'sku': case_sku, 'name': 'Reusing the freed SKU', 'typeId': PHONE,
    'items': [{'attributes': [{'key': 'colour', 'value': 'Green'},
                              {'key': 'storage', 'value': '256GB'},
                              {'key': 'screen', 'value': 'Button'}]}]})
check('the SKU of a deleted product can be reused', code == 201, r.get('message'))
REUSED = r['data']['id'] if code == 201 else None
if REUSED:
    call('DELETE', '/products/' + REUSED)

code, r = call('POST', '/products/%s/restore' % CASE)
check('restoring brings the product back', code == 200 and r['data']['is_deleted'] is False, r.get('message'))
check('the restore brings its items back too', len(r['data']['items']) == len(case_items),
      len(r['data'].get('items', [])))
check('the restored items keep their prices',
      r['data']['items'][0].get('price') is not None or r['data']['priceFrom'] is None, r['data'])

code, r = call('POST', '/products/%s/restore' % CASE)
check('restoring a live product is a 409', code == 409, r.get('message'))

# a deliberately deleted item must NOT come back with its parent
code, r = call('GET', '/products/' + IPH)
victim = r['data']['items'][0]['id']
call('DELETE', '/products/%s/items/%s' % (IPH, victim))
code, r = call('GET', '/products/' + IPH)
check('deleting one item leaves the other seven', len(r['data']['items']) == 7,
      len(r['data'].get('items', [])))

call('DELETE', '/products/' + IPH)
code, r = call('POST', '/products/%s/restore' % IPH)
check('a cascade restore does NOT resurrect an item deleted beforehand',
      len(r['data']['items']) == 7, len(r['data'].get('items', [])))

# charges, prices, availability
code, r = call('DELETE', '/charges/' + coat['data']['id'])
check('deleting a charge is soft', code == 200 and r['data']['is_deleted'] is True, r.get('data'))
code, r = call('GET', '/items/%s/charges' % car_item)
check('a deleted charge stops being collected',
      not any(c['name'] == 'Ceramic coating' for c in r['data']['optional']), r['data']['optional'])
code, r = call('POST', '/charges/%s/restore' % coat['data']['id'])
check('restoring a charge puts it back', code == 200, r.get('message'))
code, r = call('GET', '/items/%s/charges' % car_item)
check('the restored charge is collected again',
      any(c['name'] == 'Ceramic coating' for c in r['data']['optional']), r['data']['optional'])

# types and categories
code, r = call('DELETE', '/products/' + CAR)
code, r = call('DELETE', '/categories/' + CARS)
check('a category with only deleted products can now be deleted', code == 200, r.get('message'))
check('the deleted category carries the flag', r['data']['is_deleted'] is True, r.get('data'))

code, r = call('GET', '/categories')
check('a deleted category is gone from the list',
      not any(c['id'] == CARS for c in r['data']), [c['id'] for c in r['data']])

code, r = call('DELETE', '/types/' + VEH)
check('a type whose products are all deleted can be deleted', code == 200, r.get('message'))

code, r = call('GET', '/types')
live = [t['id'] for t in r['data']]
check('deleted types are hidden from the default listing', VEH not in live, live)

code, r = call('GET', '/types?includeDeleted=true')
allt = [t['id'] for t in r['data']]
check('includeDeleted=true surfaces the tombstone', VEH in allt, allt)
check('the tombstone is flagged',
      next(t for t in r['data'] if t['id'] == VEH)['is_deleted'] is True, '')

code, r = call('POST', '/types/%s/restore' % VEH)
check('restoring a type works', code == 200 and r['data']['is_deleted'] is False, r.get('message'))

code, r = call('POST', '/categories/%s/restore' % CARS)
check('restoring a category works', code == 200, r.get('message'))

print('\n' + '=' * 70)
# ------------------------------------------- 12. SKU UNIQUENESS
print()
print('[12] SKU uniqueness is partial over live rows')

_, t = call('POST', '/types', {'name': 'SKU probe', 'fields': [{'label': 'N', 'type': 'text'}]})
PROBE_T = t['data']['id']

code, a = call('POST', '/products', {'sku': 'DUP-PROBE', 'name': 'First', 'typeId': PROBE_T})
check('create a product with a fresh SKU', code == 201, a)
FIRST = a['data']['id']

code, r = call('POST', '/products', {'sku': 'DUP-PROBE', 'name': 'Second', 'typeId': PROBE_T})
check('a duplicate LIVE SKU is refused', code == 409, r.get('message'))

call('DELETE', '/products/' + FIRST)
code, d = call('POST', '/products', {'sku': 'DUP-PROBE', 'name': 'Reused', 'typeId': PROBE_T})
check('the SKU is reusable once its holder is deleted', code == 201, d.get('message'))
SECOND = d['data']['id'] if code == 201 else None

code, r = call('POST', '/products/%s/restore' % FIRST)
check('restoring onto a reused SKU is a clean 409, not a corrupt index',
      code == 409, r.get('message'))

if SECOND:
    call('DELETE', '/products/' + SECOND)
code, r = call('POST', '/products/%s/restore' % FIRST)
check('once the SKU is free again the restore succeeds', code == 200, r.get('message'))
call('DELETE', '/products/' + FIRST)
call('DELETE', '/types/' + PROBE_T)

print()
print('PASSED %d   FAILED %d' % (len(PASS), len(FAIL)))
if FAIL:
    print('\nFailures:')
    for f in FAIL:
        print('  - ' + f)
print('=' * 70)
sys.exit(1 if FAIL else 0)
