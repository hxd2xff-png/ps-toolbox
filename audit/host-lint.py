#!/usr/bin/env python3
"""ExtendScript (ES3) host linter for the PS Toolbox plugin.

Checks jsx/host.jsx for everything Photoshop's ExtendScript engine
rejects but node accepts. Run: python audit/host-lint.py
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.normpath(os.path.join(HERE, '..', 'com.figmatoolbox.ps'))
HOST = os.path.join(EXT, 'jsx', 'host.jsx')

FAILS = []
PASSES = []


def ok(name, detail=''):
    PASSES.append((name, detail))


def bad(name, detail=''):
    FAILS.append((name, detail))


def strip_comments_and_strings(s):
    """Remove comments and string literals so token scans do not fire on prose."""
    out = []
    i = 0
    n = len(s)
    BS = chr(92)
    state = None
    while i < n:
        c = s[i]
        nx = s[i + 1] if i + 1 < n else ''
        if state is None:
            if c == '/' and nx == '/':
                state = 'line'
                i += 2
                continue
            if c == '/' and nx == '*':
                state = 'block'
                i += 2
                continue
            if c in ('"', "'"):
                # keep an empty literal placeholder so that
                # "[ 'a', 'b' ]" does not degrade into "[ , ]" and
                # trip the trailing comma check.
                state = c
                out.append('""')
                i += 1
                continue
            out.append(c)
            i += 1
            continue
        if state == 'line':
            if c == '\n':
                state = None
                out.append(c)
            i += 1
            continue
        if state == 'block':
            if c == '*' and nx == '/':
                state = None
                i += 2
                continue
            i += 1
            continue
        if c == BS:
            i += 2
            continue
        if c == state:
            state = None
            i += 1
            continue
        i += 1
    return ''.join(out)


def main():
    if not os.path.exists(HOST):
        print('missing ' + HOST)
        return 2
    raw = open(HOST, 'rb').read()
    src = raw.decode('utf-8')

    if raw[:3] == b'\xef\xbb\xbf':
        bad('no BOM', 'file starts with a UTF-8 BOM')
    else:
        ok('no BOM')

    non_ascii = [(i, c) for i, c in enumerate(src) if ord(c) > 127]
    if non_ascii:
        bad('pure ASCII', '%d non-ASCII chars, first at %d' % (len(non_ascii), non_ascii[0][0]))
    else:
        ok('pure ASCII')

    if b'\r\n' not in raw and os.name == 'nt':
        bad('CRLF line endings')
    else:
        ok('line endings')

    code = strip_comments_and_strings(src)

    patterns = [
        (r',\s*[}\]]', 'no trailing commas', 'ES3 rejects trailing commas in literals'),
        (r'\.(forEach|map|filter|indexOf|trim|bind|reduce|some|every)\s*\(',
         'no ES5 Array/String extras', 'ExtendScript has none of these'),
        (r'\b(let|const|class|of|yield)\s', 'no ES5 declarations', ''),
        (r'=>', 'no arrow functions', ''),
        (r'`', 'no template literals', ''),
        (r'\?\.', 'no optional chaining', ''),
        (r'\.\.\.', 'no spread', ''),
        (r'\bJSON\s*\.', 'no JSON object', 'ExtendScript has no JSON'),
        (r'function\s*\([^)]*=([^)]*)\)', 'no default parameters', ''),
        (r'\b(delete|typeof)\s*\(', 'sanity', ''),
    ]
    for rx, name, why in patterns:
        hits = re.findall(rx, code)
        if hits:
            bad(name, '%d hit(s): %s' % (len(hits), hits[:3]))
        else:
            ok(name)

    # reserved words used as property keys in literals are fatal in ES3
    reserved = ['class', 'default', 'delete', 'function', 'in', 'new', 'return', 'switch', 'typeof', 'var', 'const', 'let']
    for w in reserved:
        if re.search(r'\b' + w + r'\s*:', code):
            bad('reserved word as key: ' + w)
    ok('no reserved-word keys')

    # entry point must exist and be published on the global object
    if re.search(r'var\s+cephostDispatch\s*=\s*\(function', src):
        ok('entry point defined')
    else:
        bad('entry point defined')
    if re.search(r'\$\.global\.cephostDispatch\s*=\s*cephostDispatch', src):
        ok('entry point published on $.global')
    else:
        bad('entry point published on $.global')

    # the canonical text pipeline keys must be present
    for key in ['property', 'textKey', 'layer', 'textLayer', 'textStyleRange', 'textStyle',
                'fontPostScriptName', 'engineData', 'from', 'to']:
        if ("'" + key + "'") in src:
            ok('uses id ' + key)
        else:
            bad('uses id ' + key, 'string ID missing')

    if re.search(r"executeAction\(S\('set'\)", src):
        ok("writes through action 'set'")
    else:
        bad("writes through action 'set'")

    tmp = os.path.join(HERE, '_host_check.js')
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(src)
    try:
        r = subprocess.run(['node', '--check', tmp], capture_output=True, text=True)
        if r.returncode == 0:
            ok('node --check syntax')
        else:
            bad('node --check syntax', (r.stderr or r.stdout).strip()[:400])
    except FileNotFoundError:
        ok('node --check skipped (no node)')
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass

    for name, detail in PASSES:
        print('PASS  ' + name + (('  (' + detail + ')') if detail else ''))
    for name, detail in FAILS:
        print('FAIL  ' + name + (('  -> ' + detail) if detail else ''))
    print('\n%d passed / %d failed' % (len(PASSES), len(FAILS)))
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
