"""Static drift check: routes declared in src/routes/*.ts vs the published spec."""
import io
import json
import os
import re
import urllib.request

SRC = (r'C:\Users\Pradeep Kumar S\Downloads\MCAAP_RD(AI Agent)\MCAAP_MCP'
       r'\Perfox-CRM\Enterprise-platform-be\enterprise-platform-backend\src')

app = io.open(os.path.join(SRC, 'app.ts'), encoding='utf-8').read()
mounts = dict(
    (var, prefix)
    for prefix, var in re.findall(r"\.use\(\s*'(/[a-zA-Z-]+)'\s*,\s*(\w+)", app)
)
imports = dict(
    (var, mod)
    for var, mod in re.findall(r"import\s+(\w+)\s+from\s+'\./routes/([\w.]+)\.js'", app)
)

live = set()
for var, prefix in mounts.items():
    mod = imports.get(var)
    if not mod:
        continue
    path = os.path.join(SRC, 'routes', mod + '.ts')
    if not os.path.exists(path):
        continue
    text = io.open(path, encoding='utf-8').read()
    for method, route in re.findall(r"router\.(get|post|put|patch|delete)\(\s*'([^']*)'", text):
        sub = '' if route == '/' else route
        full = (prefix + sub) or '/'
        full = re.sub(r':(\w+)', r'{\1}', full)
        live.add((method.upper(), full))

spec = json.loads(urllib.request.urlopen('http://localhost:5051/api/docs.json').read())
documented = set()
for path, ops in spec['paths'].items():
    for method in ops:
        if method.lower() in ('get', 'post', 'put', 'patch', 'delete'):
            documented.add((method.upper(), path))

ghosts = sorted(documented - live)
missing = sorted(live - documented)

print('routes declared : %d' % len(live))
print('spec operations : %d' % len(documented))
print()
print('DOCUMENTED BUT NOT ROUTED (ghosts): %d' % len(ghosts))
for m, p in ghosts:
    print('   %-6s %s' % (m, p))
print()
print('ROUTED BUT NOT DOCUMENTED: %d' % len(missing))
for m, p in missing:
    print('   %-6s %s' % (m, p))
