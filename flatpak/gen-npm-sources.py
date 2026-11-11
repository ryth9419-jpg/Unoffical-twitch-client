# Emit flatpak-builder archive sources for the runtime dependency closure of package.json's dependencies.
import json, sys, base64, posixpath
lock = json.load(open(sys.argv[1]))
pkgs = lock['packages']
root = pkgs['']
def resolve(frm, name):
    d = frm
    while True:
        k = posixpath.join(d, 'node_modules', name) if d else 'node_modules/' + name
        if k in pkgs: return k
        if not d: return None
        # walk up past the enclosing node_modules/<pkg>
        parts = d.split('/node_modules/')
        d = '/node_modules/'.join(parts[:-1]) if len(parts) > 1 else ''
seen, todo = set(), [('', n) for n in root.get('dependencies', {})]
while todo:
    frm, n = todo.pop()
    k = resolve(frm, n)
    if k is None: sys.exit(f'unresolved {n} from {frm!r}')
    if k in seen: continue
    seen.add(k)
    for dn in list(pkgs[k].get('dependencies', {})) + list(pkgs[k].get('optionalDependencies', {})):
        todo.append((k, dn))
out = []
for k in sorted(seen):
    p = pkgs[k]
    alg, b64 = p['integrity'].split('-', 1)
    out.append({'type': 'archive', 'url': p['resolved'], alg: base64.b64decode(b64).hex(), 'dest': k})
json.dump(out, sys.stdout, indent=2)
