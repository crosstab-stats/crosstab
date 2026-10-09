"""Emit the EXACT R the Factorial ANOVA runs, for scripts/validation/factorial-type3.R.

Pulled out of the shipped plugin rather than retyped: a validation that re-implements
the formula only proves the formula can be typed twice.

Unlike the one-way and sphericity emitters, this template NESTS — `${rStr(`.y ~ …`)}`
puts a backtick inside an interpolation — so a scanner that stops at the first backtick
silently truncates the R to a few characters and then "validates" it. Hence the depth
tracking below; it was a real failure, not a hypothetical one.

    python scripts/validation/factorial-emit-r.py [outdir]     # default: alongside this file
"""
import io
import os
import sys

SP = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                   'plugins', 'builtin-anova', 'index.js')
s = io.open(SRC, encoding='utf-8').read()
BS = chr(92)
TICK = chr(96)
Q = chr(34)


def template_from(pos):
    """Contents of the backtick template starting at or after `pos`, nesting included.

    A stack of modes, because the two states interleave: inside a template a backtick
    ends it and `${` opens an expression; inside an expression a `}` ends it and a
    backtick opens a further template. Tracking either one alone gets this wrong —
    stopping at the first backtick truncates the R to nothing, and counting braces
    without the backticks runs off the end of the function.
    """
    j = s.index(TICK, pos) + 1
    stack = ['tmpl']
    out = []
    while True:
        c = s[j]
        if c == BS:
            out.append(s[j:j + 2]); j += 2; continue
        if stack[-1] == 'tmpl':
            if c == TICK:
                stack.pop()
                if not stack:
                    return ''.join(out)
            elif c == '$' and s[j + 1] == '{':
                stack.append('expr')
                out.append(s[j:j + 2]); j += 2; continue
        else:                                   # inside ${ ... }
            if c == '}':
                stack.pop()
            elif c == TICK:
                stack.append('tmpl')
        out.append(c); j += 1


fn = s.index('export async function factorial')
r = template_from(s.index('const rCode =', fn))

# The three interpolations, resolved for a two-factor design named a and b.
decls = ('d$F1 <- factor(facs[[%sa%s]])' % (Q, Q)) + chr(10) + '    ' \
        + ('d$F2 <- factor(facs[[%sb%s]])' % (Q, Q))
def interp_end(text, start):
    """Index just past the `}` closing the `${` at `start` — braces and backticks both.

    `text.index(')}')` is not good enough: the first `)}` inside `${facNames.map(…)}`
    belongs to the nested `${rStr(n)}`, and cutting there leaves a stray bracket that
    only shows up as an R parse error several steps later.
    """
    j = start + 2
    depth = 1
    while depth:
        c = text[j]
        if c == BS:
            j += 2; continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
        elif c == TICK:                      # skip a nested template whole
            j += 1
            while text[j] != TICK:
                j += 2 if text[j] == BS else 1
        j += 1
    return j


start = r.index('${facNames')
r = r[:start] + decls + r[interp_end(r, start):]
start = r.index('${tok.map(')
r = r[:start] + '%sF1%s, %sF2%s' % (Q, Q, Q, Q) + r[interp_end(r, start):]
start = r.index('${rStr(')
r = r[:start] + '%s.y ~ F1 * F2%s' % (Q, Q) + r[interp_end(r, start):]
assert '${' not in r, r[r.index('${'):r.index('${') + 80]
assert 'drop1' in r and 'levF' in r, 'extraction looks truncated'

io.open(os.path.join(SP, 'factorial_extracted.R'), 'w', encoding='utf-8', newline='\n').write(r)
print('extracted %d chars of R from the shipped plugin' % len(r))
