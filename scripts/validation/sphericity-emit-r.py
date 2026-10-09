"""Emit the EXACT R the one-way ANOVA runs, for scripts/validation/sphericity-reference.R.

Pulled out of the shipped plugin rather than retyped: a validation that re-implements
the formula only proves the formula can be typed twice. Resolves the template holes the
way the unweighted path does (no subset, no weight).

    python scripts/validation/oneway-emit-r.py [outdir]     # default: alongside this file
"""
import io, os

import sys
SP = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'plugins', 'builtin-anova', 'index.js')
s = io.open(SRC, encoding='utf-8').read()
BS = chr(92)


def backticked_from(pos):
    """The contents of the first backtick-template starting at or after `pos`."""
    j = s.index('`', pos) + 1
    out = []
    while s[j] != '`':
        if s[j] == BS:
            out.append(s[j:j + 2])
            j += 2
            continue
        out.append(s[j])
        j += 1
    return ''.join(out)


fn = s.index('export async function repeated')
onew = backticked_from(s.index('const rCode =', fn))
assert '${' not in onew, onew[onew.index('${'):onew.index('${') + 80]
io.open(os.path.join(SP, 'repeated_extracted.R'), 'w', encoding='utf-8', newline='\n').write(onew)
print('extracted %d chars of R from the shipped plugin' % len(onew))
