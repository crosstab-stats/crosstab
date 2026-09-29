/**
 * @file spike/compare-desktop-r.mjs
 * **Does CrossTab's generated R return exactly what desktop R returns?**
 *
 *     node spike/compare-desktop-r.mjs
 *
 * Needs local R with poLCA, flexmix and lavaan. Exits non-zero on any mismatch.
 *
 * ## The question this answers, and why it is the right one
 *
 * `spike/validate-mixture-R.R` checks internal identities and parameter recovery. The owner
 * asked for something stricter and better: *"What I can't accept is the functions returning
 * something other than what desktop R returns. Build a new test that takes the same data and same
 * seed and runs it through the standard desktop R function. Compare those results. If they are
 * exact we are good."*
 *
 * That is exact, deterministic and has no tolerance to argue about. Same data, same seed, same
 * machine — a faithful wrapper must produce **bit-identical** numbers to the call a statistician
 * would type. Any difference means the wrapper is doing something: a recode that moved the
 * answer, an option that is not the default, a field extracted from the wrong place.
 *
 * ## How it stays honest
 *
 * The plugin's R is **extracted from the plugin at run time**, by calling `lca`/`lpa`/`growth`
 * with a stub that captures the code they hand to `webr.run`. Nothing is copied into this file,
 * so the comparison cannot drift from what actually ships. The reference side is written the way
 * a textbook or a package vignette writes it.
 *
 * ## Proven able to fail
 *
 * A comparison that cannot fail proves nothing, so it was checked against deliberate drift.
 * Changing one growth loading (`3*w4` to `4*w4`) in the reference is caught immediately — mEst,
 * mSe and mZ all report a difference and the run exits non-zero.
 *
 * Changing poLCA's `nrep` from 10 to 5 is NOT caught, and that turns out to be correct rather
 * than a hole: on this data every random start converges to the same optimum. Checked directly
 * on deliberately weakly-separated 3-class data (response probabilities near .5, where the
 * likelihood should be multimodal) at nrep = 2, 5, 10 and 20 — the log-likelihood moved in the
 * ninth decimal and BIC not at all. `nrep` is insurance against a bad start, not a knob that
 * changes the answer; when a difference does reach the numbers, this harness reports it, because
 * the tolerance is exact equality.
 *
 * ## What "the same call" means for a seeded model
 *
 * poLCA and flexmix use random starts, so the comparison only means something if both sides
 * consume the RNG identically. Writing this found a real bug: the pipeline used to `set.seed`
 * once and then fit k = 1, 2, 3 in a loop, so its k = 2 fit began from wherever k = 1 left the
 * stream — not from the seed. That made it differ from the single call a statistician would type,
 * and worse, it meant asking for "up to 4 classes" could change the 2-class answer you read when
 * you asked for 3. Each fit is now seeded individually, which is what makes this comparison
 * possible AND what makes the comparison table stable.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lca, lpa } from '../plugins/builtin-mixture/index.js';
import { growth } from '../plugins/builtin-sem/index.js';

const RSCRIPT = process.env.RSCRIPT || 'C:/Program Files/R/R-4.6.0/bin/Rscript.exe';
const RLIB = process.env.R_LIBS_USER || 'C:/Users/Ryan/R-libs';
const SEED = 12345;

/** Run a plugin tool with R stubbed out, and return the R it generated. */
async function generatedR(fn, inputs) {
  let code = '';
  const app = {
    data: { getVariableMeta: async () => [], getColumns: async () => ({}), create: async () => {} },
    webr: { run: async (c) => { code = c; return { result: null }; } },
    results: {
      beginAnalysis() {}, endAnalysis() {},
      appendTable: async () => {}, appendText: async () => {}, appendError: async () => {},
    },
  };
  try { await fn(app, inputs); } catch { /* the stub returns no result; we only want the code */ }
  if (!code) throw new Error('no R was generated — the tool bailed before calling webr.run');
  return code;
}

/**
 * One comparison: the data, the plugin's R (which reads `items`/`waves` as the host injects it),
 * and the reference R a statistician would write. Both produce a named list `A` and `B`; the R
 * driver compares them field by field.
 */
function block(name, setup, pluginR, referenceR, fields) {
  return `
cat("\\n=== ${name} ===\\n")
${setup}
A <- local({
${pluginR}
})
B <- local({
${referenceR}
})
for (f in c(${fields.map((f) => JSON.stringify(f)).join(', ')})) {
  a <- A[[f]]; b <- B[[f]]
  if (is.null(a) || is.null(b)) { report(f, FALSE, "missing on one side"); next }
  if (length(a) != length(b)) { report(f, FALSE, sprintf("length %d vs %d", length(a), length(b))); next }
  if (is.character(a) || is.character(b)) {
    report(f, identical(as.character(a), as.character(b)), "character")
    next
  }
  d <- max(abs(as.numeric(a) - as.numeric(b)), na.rm = TRUE)
  na_ok <- identical(is.na(as.numeric(a)), is.na(as.numeric(b)))
  report(f, na_ok && (is.na(d) || d == 0), if (is.na(d)) "all NA" else sprintf("max |diff| = %.3e", d))
}`;
}

// ---------------------------------------------------------------------------
// The three comparisons
// ---------------------------------------------------------------------------

const LCA_SETUP = `
set.seed(20260929)
mk <- function(n, p) sapply(p, function(pp) rbinom(n, 1, pp))
items <- as.data.frame(rbind(mk(400, c(.90,.85,.80,.88)), mk(200, c(.15,.20,.10,.25))))
names(items) <- c("q1","q2","q3","q4")`;

// What a statistician types: shift 0/1 to 1/2 because poLCA requires 1..K, then one call per k
// with the seed set before each — matching the pipeline's sweep.
const LCA_REFERENCE = `
  suppressMessages(library(poLCA))
  d <- items + 1L
  f <- cbind(q1, q2, q3, q4) ~ 1
  aic <- bic <- g2 <- numeric(0)
  for (k in 1:3) {
    set.seed(${SEED})
    fit <- poLCA(f, d, nclass = k, nrep = if (k == 1) 1 else 10, verbose = FALSE, maxiter = 5000)
    aic <- c(aic, fit$aic); bic <- c(bic, fit$bic); g2 <- c(g2, fit$Gsq)
    if (k == 3) best <- fit
  }
  list(cmpAic = aic, cmpBic = bic, cmpG2 = g2, share = best$P,
       assign = best$predclass, maxPost = apply(best$posterior, 1, max),
       k = 3, n = nrow(d))`;

const LPA_SETUP = `
set.seed(20260929)
items <- as.data.frame(rbind(
  cbind(rnorm(300, 0), rnorm(300, 0), rnorm(300, 0)),
  cbind(rnorm(200, 3), rnorm(200, 2.5), rnorm(200, 3.5))))
names(items) <- c("anx","dep","som")`;

const LPA_REFERENCE = `
  suppressMessages(library(flexmix))
  X <- as.matrix(items[stats::complete.cases(items), , drop = FALSE])
  aic <- bic <- ll <- numeric(0)
  for (k in 1:3) {
    set.seed(${SEED})
    fit <- flexmix(X ~ 1, k = k, model = FLXMCmvnorm(diagonal = TRUE),
                   control = list(iter.max = 1000, minprior = 0))
    aic <- c(aic, AIC(fit)); bic <- c(bic, BIC(fit)); ll <- c(ll, as.numeric(logLik(fit)))
    if (k == 3) best <- fit
  }
  pars <- parameters(best)
  cen <- as.matrix(pars[grepl("^center", rownames(pars)), , drop = FALSE])
  list(cmpAic = aic, cmpBic = bic, cmpLL = ll, share = as.numeric(best@prior),
       cenVals = as.numeric(cen), assign = flexmix::clusters(best),
       maxPost = apply(flexmix::posterior(best), 1, max), k = best@k, n = nrow(X))`;

const GROWTH_SETUP = `
set.seed(20260929)
int <- rnorm(400, 10, 2); slp <- rnorm(400, 1.5, 0.6)
waves <- as.data.frame(sapply(0:3, function(t) int + slp * t + rnorm(400, 0, 1)))
names(waves) <- c("w1","w2","w3","w4")`;

// The canonical four-occasion linear growth model, written out longhand.
const GROWTH_REFERENCE = `
  suppressMessages(library(lavaan))
  mod <- "
    i =~ 1*w1 + 1*w2 + 1*w3 + 1*w4
    s =~ 0*w1 + 1*w2 + 2*w3 + 3*w4
  "
  fit <- growth(mod, data = waves)
  pe <- parameterEstimates(fit)
  mn <- pe[pe$op == "~1" & pe$lhs %in% c("i","s"), ]
  vc <- pe[pe$op == "~~" & pe$lhs %in% c("i","s") & pe$rhs %in% c("i","s"), ]
  fm <- fitMeasures(fit, c("chisq","df","pvalue","cfi","tli","rmsea","srmr","aic","bic"))
  list(mEst = mn$est, mSe = mn$se, mZ = mn$z, mP = mn$pvalue,
       vEst = vc$est, vSe = vc$se, vP = vc$pvalue,
       fitVals = unname(fm), n = lavInspect(fit, "nobs"))`;

// ---------------------------------------------------------------------------

const [lcaR, lpaR, growthR] = await Promise.all([
  generatedR(lca, { items: ['q1', 'q2', 'q3', 'q4'], classes: 3, seed: SEED, save: 'no' }),
  generatedR(lpa, { items: ['anx', 'dep', 'som'], classes: 3, seed: SEED, save: 'no' }),
  generatedR(growth, { waves: ['w1', 'w2', 'w3', 'w4'], quadratic: 'no' }),
]);

const driver = `
.libPaths(c(${JSON.stringify(RLIB)}, .libPaths()))
options(warn = 1)
fails <- 0
report <- function(field, ok, detail) {
  if (isTRUE(ok)) cat(sprintf("  IDENTICAL  %-12s %s\\n", field, detail))
  else { cat(sprintf("  DIFFERS    %-12s %s\\n", field, detail)); fails <<- fails + 1 }
}
${block('LCA — poLCA', LCA_SETUP, lcaR, LCA_REFERENCE,
  ['k', 'n', 'cmpAic', 'cmpBic', 'cmpG2', 'share', 'assign', 'maxPost'])}
${block('LPA — flexmix', LPA_SETUP, lpaR, LPA_REFERENCE,
  ['k', 'n', 'cmpAic', 'cmpBic', 'cmpLL', 'share', 'cenVals', 'assign', 'maxPost'])}
${block('Latent growth curve — lavaan', GROWTH_SETUP, growthR, GROWTH_REFERENCE,
  ['n', 'mEst', 'mSe', 'mZ', 'mP', 'vEst', 'vSe', 'vP', 'fitVals'])}

cat("\\n================================================\\n")
if (fails == 0) cat("EVERY FIELD IDENTICAL to desktop R\\n") else cat(sprintf("%d FIELD(S) DIFFER\\n", fails))
quit(status = if (fails == 0) 0 else 1)
`;

const dir = mkdtempSync(join(tmpdir(), 'ct-cmp-'));
const path = join(dir, 'compare.R');
writeFileSync(path, driver);
console.log(`driver: ${path}`);
const run = spawnSync(RSCRIPT, [path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = `${run.stdout || ''}${run.stderr || ''}`;
process.stdout.write(out.split('\n').filter((l) => !/built under R version|^Warning message/.test(l)).join('\n'));
if (run.status !== 0) {
  writeFileSync(join(dir, 'output.txt'), out);
  console.error(`\nRscript exited ${run.status}. Driver and output kept in ${dir}`);
}
void readFileSync;
process.exit(run.status ?? 1);
