# -*- coding: utf-8 -*-
"""
Exercises /settings/site the way the UI does.

Needs a server running against a THROWAWAY database — it registers users and
writes real settings. Start one first:

    MONGODB_URI=mongodb://localhost:27017/enterprise_platform_settingscheck       PORT=5096 npx tsx src/server.ts

then `python tests/settings_check.py`.
"""
import json, sys, urllib.error, urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

API = 'http://localhost:5096'
P, F = [], []


def ck(name, cond, detail=''):
    (P if cond else F).append(name)
    print(('  OK   ' if cond else '  FAIL ') + name + ('' if cond else '  <- ' + str(detail)[:200]))


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


def register(name, email, password, role):
    code, body = call('POST', '/api/v1/auth/register',
                      {'name': name, 'email': email, 'password': password, 'role': role})
    if code not in (200, 201):
        code, body = call('POST', '/api/v1/auth/login', {'email': email, 'password': password})
    return body['data']['token']


print('=' * 68)
print('SITE SETTINGS')
print('=' * 68)

admin = register('Set Admin', 'set-admin@example.com', 'SetAdmin!2345', 'Admin')
viewer = register('Set Viewer', 'set-viewer@example.com', 'SetViewer!2345', 'Viewer')

# ----------------------------------------------------------------- read
code, r = call('GET', '/api/v1/settings/site', token=admin)
ck('a workspace that never saved still answers', code == 200, r.get('message'))
d = r.get('data', {})
ck('with sensible defaults', d.get('siteName') == 'OmniFlow' and d.get('tagline') == 'Perfox Assistant', d)
ck('and no mongo internals', '_id' not in d and '__v' not in d, list(d))

code, r = call('GET', '/api/v1/settings/site')
ck('reading requires a token', code == 401, code)

# ---------------------------------------------------------------- write
code, r = call('PUT', '/api/v1/settings/site',
               {'siteName': 'Skillmine', 'tagline': 'Enterprise Platform',
                'businessType': 'Professional services'}, token=admin)
ck('an Admin can save', code == 200, r.get('message'))
ck('the values come back saved', r['data']['siteName'] == 'Skillmine', r.get('data'))

code, r = call('GET', '/api/v1/settings/site', token=admin)
ck('and survive a re-read', r['data']['siteName'] == 'Skillmine', r.get('data'))
ck('the legal name was untouched by a patch that omitted it',
   r['data']['legalName'] == '', r.get('data'))
ck('who changed it is recorded', r['data'].get('updatedBy') == 'set-admin@example.com', r.get('data'))
ck('and when', bool(r['data'].get('updatedAt')), r.get('data'))

# a second write must not create a second document
code, r = call('PUT', '/api/v1/settings/site', {'legalName': 'Skillmine Pvt Ltd'}, token=admin)
ck('a partial patch keeps the other fields',
   r['data']['siteName'] == 'Skillmine' and r['data']['legalName'] == 'Skillmine Pvt Ltd',
   r.get('data'))

# ------------------------------------------------------------ permissions
code, r = call('PUT', '/api/v1/settings/site', {'siteName': 'Hijacked'}, token=viewer)
ck('a non-Admin cannot save', code == 403, code)
code, r = call('GET', '/api/v1/settings/site', token=viewer)
ck('but can still read', code == 200 and r['data']['siteName'] == 'Skillmine', r.get('data'))

# ------------------------------------------------------------ validation
code, r = call('PUT', '/api/v1/settings/site', {'siteName': ''}, token=admin)
ck('an empty website name is refused', code == 400, code)

code, r = call('PUT', '/api/v1/settings/site', {'logoUrl': 'javascript:alert(1)'}, token=admin)
ck('a non-image logo value is refused', code == 400, code)

code, r = call('PUT', '/api/v1/settings/site',
               {'logoUrl': 'data:image/png;base64,iVBORw0KGgo='}, token=admin)
ck('a data-url image is accepted', code == 200, r.get('message'))

code, r = call('PUT', '/api/v1/settings/site',
               {'faviconUrl': 'data:image/png;base64,' + 'A' * (900 * 1024)}, token=admin)
ck('an oversized image is refused', code in (400, 413, 422), code)

code, r = call('GET', '/api/v1/settings/site', token=admin)
ck('the oversized one did not get through', not r['data']['faviconUrl'], r['data'].get('faviconUrl'))

print()
print('PASSED %d   FAILED %d' % (len(P), len(F)))
for f in F:
    print('  - ' + f)
sys.exit(1 if F else 0)
