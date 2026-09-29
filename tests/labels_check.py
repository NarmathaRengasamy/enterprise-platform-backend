# -*- coding: utf-8 -*-
"""Exercises the module labels the way the Settings page does."""
import json, sys, urllib.error, urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

API = 'http://localhost:5051'
P, F = [], []


def ck(name, cond, detail=''):
    (P if cond else F).append(name)
    print(('  OK   ' if cond else '  FAIL ') + name + ('' if cond else '  <- ' + str(detail)[:220]))


def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        r = urllib.request.urlopen(req)
        return r.getcode(), json.load(r)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {'message': raw[:200]}


_, login = call('POST', '/api/v1/auth/login',
                {'email': 'sarah@omniflow.io', 'password': 'password123'})
TOKEN = login['data']['token']

print('=' * 68)
print('MODULE LABELS')
print('=' * 68)

code, r = call('GET', '/api/v1/settings/site', token=TOKEN)
labels = r['data'].get('labels', {})
ck('every module comes back, defaults filled in',
   set(labels) == {'dashboard', 'conversations', 'products', 'schedule', 'teams',
                   'knowledgeBase', 'developer'}, list(labels))
ck('each has both forms',
   all('plural' in v and 'singular' in v for v in labels.values()), labels)
ck('shipped wording is the default',
   labels['conversations'] == {'plural': 'Conversations', 'singular': 'Conversation'},
   labels.get('conversations'))

print()
print('[Rename]')
code, r = call('PUT', '/api/v1/settings/site',
               {'labels': {**labels,
                           'conversations': {'plural': 'Interactions', 'singular': 'Interaction'}}},
               token=TOKEN)
ck('a rename saves', code == 200, r.get('message'))
ck('the save response already carries it',
   r['data']['labels']['conversations']['plural'] == 'Interactions',
   r['data']['labels'].get('conversations'))

code, r = call('GET', '/api/v1/settings/site', token=TOKEN)
ck('and it survives a re-read',
   r['data']['labels']['conversations'] == {'plural': 'Interactions', 'singular': 'Interaction'},
   r['data']['labels'].get('conversations'))
ck('untouched modules keep their defaults',
   r['data']['labels']['products']['plural'] == 'Products', r['data']['labels'].get('products'))

print()
print('[Reset]')
code, r = call('PUT', '/api/v1/settings/site',
               {'labels': {**r['data']['labels'],
                           'conversations': {'plural': 'Conversations', 'singular': 'Conversation'}}},
               token=TOKEN)
ck('resetting to the default is accepted', code == 200, r.get('message'))
ck('and reads back as the default',
   r['data']['labels']['conversations']['plural'] == 'Conversations',
   r['data']['labels'].get('conversations'))

print()
print('[Validation]')
code, r = call('PUT', '/api/v1/settings/site',
               {'labels': {'nonsense': {'plural': 'X', 'singular': 'X'}}}, token=TOKEN)
ck('an unknown module key is refused', code == 400, code)

code, r = call('PUT', '/api/v1/settings/site',
               {'labels': {'products': {'plural': '', 'singular': 'Item'}}}, token=TOKEN)
ck('an empty name is refused', code == 400, code)

code, r = call('PUT', '/api/v1/settings/site',
               {'labels': {'products': {'plural': 'x' * 41, 'singular': 'Item'}}}, token=TOKEN)
ck('an over-long name is refused', code == 400, code)

code, r = call('PUT', '/api/v1/settings/site',
               {'labels': {'products': {'plural': '  Catalogue  ', 'singular': '  Item  '}}},
               token=TOKEN)
ck('whitespace is trimmed',
   r['data']['labels']['products'] == {'plural': 'Catalogue', 'singular': 'Item'},
   r['data']['labels'].get('products'))

code, r = call('PUT', '/api/v1/settings/site',
               {'siteName': 'Ecomm'}, token=TOKEN)
ck('a patch that omits labels leaves them alone',
   r['data']['labels']['products']['plural'] == 'Catalogue', r['data']['labels'].get('products'))

# put everything back the way it was
call('PUT', '/api/v1/settings/site',
     {'labels': {'products': {'plural': 'Products', 'singular': 'Product'}}}, token=TOKEN)
code, r = call('GET', '/api/v1/settings/site', token=TOKEN)
ck('restored to shipped defaults',
   all(r['data']['labels'][k]['plural'] == v for k, v in
       [('dashboard', 'Dashboard'), ('conversations', 'Conversations'), ('products', 'Products'),
        ('schedule', 'Schedule'), ('teams', 'Teams'), ('knowledgeBase', 'Knowledge Base'),
        ('developer', 'Developer')]),
   r['data']['labels'])

print()
print('PASSED %d   FAILED %d' % (len(P), len(F)))
for f in F:
    print('  - ' + f)
sys.exit(1 if F else 0)
