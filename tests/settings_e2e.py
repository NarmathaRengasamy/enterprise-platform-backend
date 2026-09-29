# -*- coding: utf-8 -*-
"""
End-to-end check of workspace settings and navigation labels.

    python tests/settings_e2e.py                    # against a throwaway db
    TEST_API=http://localhost:5051 python tests/settings_e2e.py --live

By default it starts its own server against a test database and creates the
two accounts it needs.

`--live` points it at an already-running server. It then creates nothing and
changes nothing permanently: the current settings are SNAPSHOT first and
restored at the end, and the accounts must already exist --

    E2E_ADMIN_EMAIL=you@example.com  E2E_ADMIN_PASSWORD=...  \
    E2E_VIEWER_EMAIL=someone@example.com  E2E_VIEWER_PASSWORD=...  \
    TEST_API=http://localhost:5051 python tests/settings_e2e.py --live

Covers the whole round trip the Settings page makes: read, identity, brand
assets, every navigation label, permissions, validation, and reset.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)

LIVE = '--live' in sys.argv
PORT = int(os.environ.get('TEST_PORT', '5094'))
DB = os.environ.get('TEST_DB', 'enterprise_platform_e2e')
MONGO_HOST = os.environ.get('TEST_MONGO_HOST', 'mongodb://localhost:27017')
API = os.environ.get('TEST_API', 'http://localhost:%d' % PORT)

MODULES = ['dashboard', 'conversations', 'products', 'allProducts', 'categories',
           'schedule', 'teams', 'knowledgeBase', 'developer']

DEFAULTS_FULL = {
    'dashboard': {'plural': 'Dashboard', 'singular': 'Dashboard'},
    'conversations': {'plural': 'Conversations', 'singular': 'Conversation'},
    'products': {'plural': 'Products', 'singular': 'Product'},
    'allProducts': {'plural': 'All Products', 'singular': 'Product'},
    'categories': {'plural': 'Categories', 'singular': 'Category'},
    'schedule': {'plural': 'Schedule', 'singular': 'Appointment'},
    'teams': {'plural': 'Teams', 'singular': 'Member'},
    'knowledgeBase': {'plural': 'Knowledge Base', 'singular': 'Article'},
    'developer': {'plural': 'Developer', 'singular': 'Endpoint'},
}

DEFAULTS = {
    'dashboard': 'Dashboard', 'conversations': 'Conversations', 'products': 'Products',
    'allProducts': 'All Products', 'categories': 'Categories',
    'schedule': 'Schedule', 'teams': 'Teams', 'knowledgeBase': 'Knowledge Base',
    'developer': 'Developer',
}

ADMIN = {
    'name': 'E2E Admin',
    'email': os.environ.get('E2E_ADMIN_EMAIL', 'e2e-admin@example.com'),
    'password': os.environ.get('E2E_ADMIN_PASSWORD', 'E2eAdmin!2345'),
    'role': 'Admin',
}
VIEWER = {
    'name': 'E2E Viewer',
    'email': os.environ.get('E2E_VIEWER_EMAIL', 'e2e-viewer@example.com'),
    'password': os.environ.get('E2E_VIEWER_PASSWORD', 'E2eViewer!2345'),
    'role': 'Viewer',
}

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


def sign_in(user, allow_register=True):
    """
    Signs in, creating the account only when that is safe.

    In `--live` mode registering would leave test accounts behind in a real
    workspace, so the credentials have to be ones that already exist and are
    passed in. Creating users as a side effect of running a test is exactly
    the sort of mess that is easy to leave and hard to notice.
    """
    code, body = call('POST', '/api/v1/auth/login',
                      {'email': user['email'], 'password': user['password']})
    if code == 200:
        return body['data']['token']

    if not allow_register:
        print('Could not sign in as %s.' % user['email'])
        print('In --live mode nothing is created, so pass real credentials:')
        print('  E2E_ADMIN_EMAIL=...  E2E_ADMIN_PASSWORD=...')
        print('  E2E_VIEWER_EMAIL=... E2E_VIEWER_PASSWORD=...')
        print('  TEST_API=http://localhost:5051 python tests/settings_e2e.py --live')
        sys.exit(2)

    code, body = call('POST', '/api/v1/auth/register', user)
    if code not in (200, 201):
        print('Could not create %s: %s' % (user['email'], body.get('message')))
        sys.exit(2)
    return body['data']['token']


def wait_for_health(timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(API + '/api/health', timeout=2) as r:
                if json.load(r).get('database') == 'connected':
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False


# 1x1 transparent PNG.
PNG = ('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA'
       'C0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=')


def run():
    print('=' * 70)
    print('SETTINGS — END TO END')
    print('=' * 70)
    print('  api : %s%s' % (API, '   (live — will restore)' if LIVE else '   (throwaway)'))
    print()

    # Against a live workspace nothing is created — see `sign_in`.
    admin = sign_in(ADMIN, allow_register=not LIVE)
    viewer = sign_in(VIEWER, allow_register=not LIVE)

    # ---------------------------------------------------------- snapshot
    code, before = call('GET', '/api/v1/settings/site', token=admin)
    ck('settings are readable', code == 200, before.get('message'))
    original = before.get('data', {})

    # ------------------------------------------------------------- shape
    print('\n[Shape]')
    ck('identity fields are present',
       all(k in original for k in ('siteName', 'legalName', 'tagline', 'logoUrl', 'faviconUrl')),
       list(original))
    ck('business category is present', 'businessType' in original, list(original))
    ck('every module has a label', set(original.get('labels', {})) == set(MODULES),
       list(original.get('labels', {})))
    ck('no mongo internals leak',
       '_id' not in original and '__v' not in original and
       all('$__parent' not in v for v in original.get('labels', {}).values()),
       original.get('labels'))

    # ---------------------------------------------------------- identity
    print('\n[Workspace identity]')
    code, r = call('PUT', '/api/v1/settings/site', {
        'siteName': 'E2E Workspace',
        'tagline': 'Automated',
        'legalName': 'E2E Holdings Ltd',
        'businessType': 'Manufacturing',
    }, token=admin)
    ck('identity saves', code == 200, r.get('message'))
    d = r.get('data', {})
    ck('the response carries every field back',
       d.get('siteName') == 'E2E Workspace' and d.get('tagline') == 'Automated'
       and d.get('legalName') == 'E2E Holdings Ltd' and d.get('businessType') == 'Manufacturing', d)

    code, r = call('GET', '/api/v1/settings/site', token=admin)
    ck('and survives a re-read', r['data']['siteName'] == 'E2E Workspace', r.get('data'))
    ck('who changed it is recorded', r['data'].get('updatedBy') == ADMIN['email'], r['data'].get('updatedBy'))

    # ------------------------------------------------------------- brand
    print('\n[Brand assets]')
    code, r = call('PUT', '/api/v1/settings/site', {'logoUrl': PNG, 'faviconUrl': PNG}, token=admin)
    ck('a logo and favicon save', code == 200 and r['data']['logoUrl'] == PNG, r.get('message'))
    code, r = call('PUT', '/api/v1/settings/site', {'logoUrl': ''}, token=admin)
    ck('removing the logo leaves the favicon', r['data']['logoUrl'] == '' and r['data']['faviconUrl'] == PNG,
       {'logo': r['data']['logoUrl'][:20], 'favicon': r['data']['faviconUrl'][:20]})
    code, r = call('PUT', '/api/v1/settings/site', {'logoUrl': 'javascript:alert(1)'}, token=admin)
    ck('a non-image value is refused', code == 400, code)
    code, r = call('PUT', '/api/v1/settings/site',
                   {'logoUrl': 'data:image/png;base64,' + 'A' * (900 * 1024)}, token=admin)
    ck('an oversized image is refused', code in (400, 413, 422), code)

    # ------------------------------------------------------------ labels
    print('\n[Navigation labels]')
    renamed = {key: {'plural': 'X-%s' % key, 'singular': 'X-%s-one' % key} for key in MODULES}
    code, r = call('PUT', '/api/v1/settings/site', {'labels': renamed}, token=admin)
    ck('every module can be renamed at once', code == 200, r.get('message'))
    ck('all nine come back renamed',
       all(r['data']['labels'][k]['plural'] == 'X-%s' % k for k in MODULES), r['data'].get('labels'))

    code, r = call('GET', '/api/v1/settings/site', token=admin)
    ck('and all nine survive a re-read',
       all(r['data']['labels'][k]['plural'] == 'X-%s' % k for k in MODULES), r['data'].get('labels'))
    ck('the singular is stored alongside',
       all(r['data']['labels'][k]['singular'] == 'X-%s-one' % k for k in MODULES),
       r['data'].get('labels'))

    # one back to default, the rest untouched
    code, r = call('PUT', '/api/v1/settings/site',
                   {'labels': {**renamed,
                               'products': {'plural': 'Products', 'singular': 'Product'}}},
                   token=admin)
    ck('one module can be reset on its own',
       r['data']['labels']['products']['plural'] == 'Products'
       and r['data']['labels']['conversations']['plural'] == 'X-conversations',
       r['data'].get('labels'))

    code, r = call('PUT', '/api/v1/settings/site', {'siteName': 'E2E Workspace 2'}, token=admin)
    ck('a patch that omits labels leaves them alone',
       r['data']['labels']['conversations']['plural'] == 'X-conversations',
       r['data']['labels'].get('conversations'))

    # Renaming ONE module must leave the other eight alone.
    #
    # `$set: { labels }` replaced the whole map, so this exact call wiped a
    # live workspace's other eight names. The admin form sends every key every
    # time, which is why it never showed there — the API was destructive for
    # anyone doing the obvious thing.
    call('PUT', '/api/v1/settings/site', {'labels': renamed}, token=admin)
    code, r = call('PUT', '/api/v1/settings/site',
                   {'labels': {'products': {'plural': 'Solo', 'singular': 'Solo'}}}, token=admin)
    ck('a one-module rename is accepted', code == 200, r.get('message'))
    ck('it changes the one named', r['data']['labels']['products']['plural'] == 'Solo',
       r['data']['labels'].get('products'))
    survivors = [k for k in MODULES if k != 'products']
    ck('and leaves every other module alone',
       all(r['data']['labels'][k]['plural'] == 'X-%s' % k for k in survivors),
       {k: r['data']['labels'][k]['plural'] for k in survivors})

    code, r = call('GET', '/api/v1/settings/site', token=admin)
    ck('the merge survives a re-read',
       r['data']['labels']['products']['plural'] == 'Solo'
       and all(r['data']['labels'][k]['plural'] == 'X-%s' % k for k in survivors),
       {k: r['data']['labels'][k]['plural'] for k in MODULES})

    # Resetting one must also leave the rest untouched.
    code, r = call('PUT', '/api/v1/settings/site',
                   {'labels': {'products': DEFAULTS_FULL['products']}}, token=admin)
    ck('resetting one module does not disturb the others',
       r['data']['labels']['products']['plural'] == 'Products'
       and all(r['data']['labels'][k]['plural'] == 'X-%s' % k for k in survivors),
       {k: r['data']['labels'][k]['plural'] for k in MODULES})

    # The singular is normally worked out from the plural, but the form lets
    # it be set by hand. A value the guess could never produce proves the
    # override is stored rather than quietly re-derived on the way in or out.
    code, r = call('PUT', '/api/v1/settings/site',
                   {'labels': {**renamed,
                               'products': {'plural': 'MY Cars', 'singular': 'Vehicle'}}},
                   token=admin)
    ck('a hand-written singular is accepted', code == 200, r.get('message'))
    ck('and is not re-derived from the plural',
       r['data']['labels']['products'] == {'plural': 'MY Cars', 'singular': 'Vehicle'},
       r['data']['labels'].get('products'))

    code, r = call('GET', '/api/v1/settings/site', token=admin)
    ck('the override survives a re-read',
       r['data']['labels']['products']['singular'] == 'Vehicle',
       r['data']['labels'].get('products'))

    code, r = call('PUT', '/api/v1/settings/site',
                   {'labels': {**renamed,
                               'products': {'plural': 'MY Cars', 'singular': 'MY Car'}}},
                   token=admin)
    ck('and can be put back to the derived form',
       r['data']['labels']['products']['singular'] == 'MY Car',
       r['data']['labels'].get('products'))

    # ------------------------------------------------------- validation
    print('\n[Validation]')
    for body, what in [
        ({'siteName': ''}, 'an empty workspace name'),
        ({'siteName': '   '}, 'a whitespace-only name'),
        ({'siteName': 'x' * 61}, 'a name over 60 characters'),
        ({'labels': {'nope': {'plural': 'A', 'singular': 'A'}}}, 'an unknown module key'),
        ({'labels': {'products': {'plural': '', 'singular': 'Item'}}}, 'an empty label'),
        ({'labels': {'products': {'plural': 'x' * 41, 'singular': 'Item'}}}, 'a label over 40 characters'),
    ]:
        code, r = call('PUT', '/api/v1/settings/site', body, token=admin)
        ck('%s is refused' % what, code == 400, code)

    code, r = call('PUT', '/api/v1/settings/site',
                   {'siteName': '  Padded  ', 'labels': {'teams': {'plural': '  Crew  ', 'singular': '  Hand  '}}},
                   token=admin)
    ck('whitespace is trimmed everywhere',
       r['data']['siteName'] == 'Padded' and r['data']['labels']['teams'] == {'plural': 'Crew', 'singular': 'Hand'},
       {'name': r['data']['siteName'], 'teams': r['data']['labels'].get('teams')})

    # ------------------------------------------------------ permissions
    print('\n[Permissions]')
    code, r = call('GET', '/api/v1/settings/site')
    ck('reading needs a token', code == 401, code)
    code, r = call('GET', '/api/v1/settings/site', token=viewer)
    ck('any signed-in user can read', code == 200, code)
    code, r = call('PUT', '/api/v1/settings/site', {'siteName': 'Hijacked'}, token=viewer)
    ck('a non-Admin cannot write', code == 403, code)
    code, r = call('PUT', '/api/v1/settings/site',
                   {'labels': {'teams': {'plural': 'Hijacked', 'singular': 'H'}}}, token=viewer)
    ck('a non-Admin cannot rename either', code == 403, code)

    # ------------------------------------------------- the signed-out view
    #
    # The sign-in screen has no token but still has to show the workspace's
    # own name, logo and section names. What it must NOT be able to see is
    # the registered legal name, the business category or the email of
    # whoever last saved.
    print('\n[Public branding]')
    code, pub = call('GET', '/public/settings')
    ck('branding is readable with no token at all', code == 200, code)
    published = pub.get('data', {})
    ck('it carries the name, tagline, logo and labels',
       set(published) == {'siteName', 'tagline', 'logoUrl', 'faviconUrl', 'labels'},
       sorted(published))
    ck('every module is named', set(published.get('labels', {})) == set(MODULES),
       sorted(published.get('labels', {})))

    for private in ('legalName', 'businessType', 'updatedBy', 'updatedAt', 'id'):
        ck('%s is NOT published' % private, private not in published, published.get(private))

    # A rename made while signed in has to reach the signed-out screens.
    call('PUT', '/api/v1/settings/site',
         {'labels': {'products': {'plural': 'Widgets', 'singular': 'Widget'}}}, token=admin)
    code, pub = call('GET', '/public/settings')
    ck('a rename reaches the signed-out pages',
       pub['data']['labels']['products']['plural'] == 'Widgets',
       pub['data']['labels'].get('products'))

    ck('the public endpoint is read-only',
       call('PUT', '/public/settings', {'siteName': 'Hijacked'})[0] == 404
       and call('POST', '/public/settings', {})[0] == 404)

    # ------------------------------------------------------- no caching
    print('\n[Caching]')
    req = urllib.request.Request(API + '/api/v1/settings/site',
                                 headers={'Authorization': 'Bearer ' + admin})
    with urllib.request.urlopen(req) as first:
        etag = first.headers.get('ETag')
        cache = first.headers.get('Cache-Control')
    ck('no ETag, so a repeat read cannot 304', etag is None, etag)
    ck('and it is marked no-store', cache == 'no-store', cache)

    # ---------------------------------------------------------- restore
    print('\n[Restore]')
    restore = {k: original.get(k) for k in
               ('siteName', 'legalName', 'tagline', 'logoUrl', 'faviconUrl', 'businessType')}
    restore['labels'] = original.get('labels', {})
    code, r = call('PUT', '/api/v1/settings/site', restore, token=admin)
    ck('the original settings go back', code == 200, r.get('message'))
    code, r = call('GET', '/api/v1/settings/site', token=admin)
    ck('name restored', r['data']['siteName'] == original.get('siteName'), r['data'].get('siteName'))
    ck('labels restored',
       all(r['data']['labels'][k]['plural'] == original['labels'][k]['plural'] for k in MODULES),
       r['data'].get('labels'))

    print()
    print('PASSED %d   FAILED %d' % (len(P), len(F)))
    for f in F:
        print('  - ' + f)
    return 1 if F else 0


def main():
    if LIVE:
        return run()

    if 'test' not in DB.lower() and 'e2e' not in DB.lower():
        print('REFUSING TO RUN: %s does not look like a test database.' % DB)
        return 2

    uri = '%s/%s' % (MONGO_HOST.rstrip('/'), DB)
    try:
        from pymongo import MongoClient  # type: ignore
        MongoClient(MONGO_HOST).drop_database(DB)
        print('  database dropped')
    except ImportError:
        print('  (pymongo not installed — database not reset)')

    env = {**os.environ, 'MONGODB_URI': uri, 'PORT': str(PORT), 'NODE_ENV': 'test'}
    server = subprocess.Popen(['node', 'dist/server.js'], cwd=BACKEND, env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              shell=(os.name == 'nt'))
    try:
        if not wait_for_health():
            print('server did not come up on %s — run `npm run build` first' % API)
            return 1
        return run()
    finally:
        if os.name == 'nt':
            subprocess.call(['taskkill', '/T', '/F', '/PID', str(server.pid)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            server.terminate()
        try:
            server.wait(timeout=10)
        except Exception:
            server.kill()
        print('  server stopped')


if __name__ == '__main__':
    sys.exit(main())
