# -*- coding: utf-8 -*-
"""
Runs the v2 catalogue suites against a THROWAWAY database.

    python tests/run_tests.py

Both suites clear the whole v2 catalogue before they run, because their
assertions depend on an exact starting state. That is correct for a test
suite and catastrophic if it is pointed at real data.

Two things keep them apart:

  1. This runner starts its own backend with MONGODB_URI set to a test
     database, on a port of its own.
  2. `assert_not_production()` refuses to continue if that database name is
     anything but the test one.

Changing the port alone is NOT enough — two servers on different ports share
one database if the connection string is the same. That is exactly how a live
catalogue got wiped twice during development.
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

PORT = int(os.environ.get('TEST_PORT', '5099'))
DB = os.environ.get('TEST_DB', 'enterprise_platform_test')
MONGO_HOST = os.environ.get('TEST_MONGO_HOST', 'mongodb://localhost:27017')
TEST_URI = '%s/%s' % (MONGO_HOST.rstrip('/'), DB)
BASE = 'http://localhost:%d' % PORT

USERS = [
    {'name': 'V2 Tester', 'email': 'v2tester@example.com', 'password': 'V2tester!2345'},
    {'name': 'CRUD Tester', 'email': 'crud-tmp@example.com', 'password': 'Crud!12345'},
]

SUITES = [
    ('v2_regression.py', 'v2 regression'),
    ('v2_crud.py', 'edit / delete / restore'),
    ('v2_media.py', 'product media'),
    ('v2_open_choice.py', 'open choice fields'),
]


def assert_not_production():
    """The guard. A test database has to look like one."""
    if 'test' not in DB.lower():
        print('REFUSING TO RUN')
        print('  TEST_DB is "%s", which does not look like a test database.' % DB)
        print('  These suites DELETE every catalogue row before they run.')
        sys.exit(2)

    dotenv = os.path.join(BACKEND, '.env')
    if os.path.exists(dotenv):
        with open(dotenv, encoding='utf-8') as fh:
            for line in fh:
                m = re.match(r'\s*MONGODB_URI\s*=\s*(\S+)', line)
                if m and m.group(1).rstrip('/') == TEST_URI.rstrip('/'):
                    print('REFUSING TO RUN')
                    print('  .env already points at %s.' % TEST_URI)
                    print('  The test database must be separate from the one the app uses.')
                    sys.exit(2)


def drop_test_database():
    """
    Starts every run from an empty database.

    Without this the test database accumulates across runs, and suites that
    assert on a listing start failing once the tombstones outgrow one page.
    Dropping is safe precisely because `assert_not_production` has already
    established this is a throwaway.
    """
    try:
        from pymongo import MongoClient  # type: ignore
    except ImportError:
        print('  (pymongo not installed \u2014 database not reset between runs)')
        return
    MongoClient(MONGO_HOST).drop_database(DB)
    print('  database dropped')


def assert_port_free():
    """
    Refuses to run if something is already listening on the test port.

    `server.terminate()` on Windows kills the `npx` wrapper and leaves the node
    process behind, so a previous run can still hold the port. The next run
    then passes its health check against that stale server and silently tests
    yesterday's code — which is exactly how a real index bug looked like a
    passing suite. Better to stop and say so.
    """
    import socket
    sock = socket.socket()
    sock.settimeout(1)
    busy = sock.connect_ex(('127.0.0.1', PORT)) == 0
    sock.close()
    if not busy:
        return

    print('REFUSING TO RUN')
    print('  Something is already listening on port %d.' % PORT)
    print('  It is probably a server left over from an earlier run; the suites')
    print('  would test THAT one, not the code you just changed.')
    print()
    print('  Find and stop it:')
    print('    netstat -ano | findstr :%d' % PORT)
    print('    taskkill /T /F /PID <pid>')
    sys.exit(2)


def stop(server):
    """
    Kills the server and everything it spawned.

    `npx` is a wrapper: terminating it orphans the node process holding the
    port. On Windows only `taskkill /T` walks the tree.
    """
    if os.name == 'nt':
        subprocess.call(['taskkill', '/T', '/F', '/PID', str(server.pid)],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        server.terminate()
    try:
        server.wait(timeout=10)
    except Exception:
        server.kill()


UPLOADS = os.path.join(BACKEND, 'uploads', 'products')


def snapshot_uploads():
    """What was in the upload folder before the run."""
    try:
        return set(os.listdir(UPLOADS))
    except OSError:
        return set()


def clean_uploads(before):
    """
    Deletes only the files this run created.

    The media suite uploads real bytes, and the ones it never detaches would
    otherwise pile up run after run. Comparing against a snapshot rather than
    emptying the folder matters because the test server and the development
    server share it — emptying it would take real product pictures with it.
    """
    removed = 0
    for name in snapshot_uploads() - before:
        try:
            os.remove(os.path.join(UPLOADS, name))
            removed += 1
        except OSError:
            pass
    if removed:
        print('  %d test upload(s) removed' % removed)


def wait_for_health(timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(BASE + '/api/health', timeout=2) as r:
                if json.load(r).get('database') == 'connected':
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False


def register(user):
    body = json.dumps({**user, 'role': 'Admin'}).encode()
    req = urllib.request.Request(BASE + '/api/v1/auth/register', data=body,
                                 headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req)
        return 'created'
    except urllib.error.HTTPError:
        return 'exists'


def main():
    assert_not_production()
    assert_port_free()

    print('=' * 68)
    print('CATALOGUE V2 TEST RUN')
    print('=' * 68)
    print('  database : %s      <- throwaway' % TEST_URI)
    print('  port     : %d' % PORT)
    print()

    drop_test_database()
    uploads_before = snapshot_uploads()

    env = {**os.environ, 'MONGODB_URI': TEST_URI, 'PORT': str(PORT), 'NODE_ENV': 'test'}
    server = subprocess.Popen(
        ['npx', 'tsx', 'src/server.ts'], cwd=BACKEND, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=(os.name == 'nt'))

    try:
        if not wait_for_health():
            print('server did not come up on %s' % BASE)
            return 1
        print('  server up')
        for u in USERS:
            print('  user %-26s %s' % (u['email'], register(u)))
        print()

        failed = []
        for filename, label in SUITES:
            print('-' * 68)
            print(label)
            print('-' * 68)
            code = subprocess.call([sys.executable, os.path.join(HERE, filename)],
                                   env={**os.environ, 'TEST_API': BASE})
            if code != 0:
                failed.append(label)
            print()

        print('=' * 68)
        if failed:
            print('FAILED: ' + ', '.join(failed))
        else:
            print('ALL SUITES PASSED')
        print('=' * 68)
        return 1 if failed else 0
    finally:
        stop(server)
        print('  server stopped')
        clean_uploads(uploads_before)


if __name__ == '__main__':
    sys.exit(main())
