# Validation for the R behind #141 — latent class, latent profile, latent growth.
#
#   Rscript spike/validate-mixture-R.R
#
# Needs local R with poLCA, flexmix and lavaan. It does NOT run in CI: the point is to check the
# R against a real R, which WebR and node cannot do.
#
# ## Why this file exists, and what it is allowed to claim
#
# The plugin does not implement these estimators; poLCA, flexmix and lavaan do. So what needs
# validating is the WIRING — that the recode, the formula, the extraction and the marshalling
# deliver the quantities they claim to. A wiring error does not produce a slightly-off number, it
# produces a wildly wrong one or an error, which is exactly what simulated data with a known
# structure detects.
#
# It is NOT a precision check, and a first version of this claimed more than it could:
# "recovered class shares .659/.341 (true .667/.333)". Those are not equal and never will be,
# because an estimate from 600 sampled cases is not the population parameter. The owner pushed
# back on exactly that, and rightly. So this script makes two KINDS of assertion:
#
#  1. **Exact identities**, which hold to floating point no matter what the sample looks like —
#     a BIC that disagrees with -2logL + npar*log(n) is a bug, full stop. These are the real
#     tests; they cannot pass by luck.
#  2. **Recovery within sampling error**, stated in standard errors with an explicit tolerance
#     (|z| < 4, which is ~1-in-16,000 per check under the null). This is a smoke test with a
#     known answer. It catches "the wrong field was extracted"; it does not certify accuracy.
#
# A failure of (1) is a defect. A failure of (2) is a prompt to look, not a verdict.

.libPaths(c("C:/Users/Ryan/R-libs", .libPaths()))
options(warn = 1)
fails <- 0

ok <- function(cond, what) {
  if (isTRUE(cond)) cat(sprintf("  ok    %s\n", what))
  else { cat(sprintf("  FAIL  %s\n", what)); fails <<- fails + 1 }
}
# An identity: must hold to floating point, whatever the data.
exact <- function(a, b, what, tol = 1e-6) {
  d <- abs(a - b)
  if (is.finite(d) && d < tol) cat(sprintf("  ok    %s  (|diff| = %.2e)\n", what, d))
  else { cat(sprintf("  FAIL  %s  got %.6f want %.6f\n", what, a, b)); fails <<- fails + 1 }
}
# Recovery: how many standard errors from the parameter used to generate the data.
recov <- function(est, true, se, what, maxz = 4) {
  z <- abs(est - true) / se
  tag <- if (is.finite(z) && z < maxz) "ok   " else "FAIL "
  if (!(is.finite(z) && z < maxz)) fails <<- fails + 1
  cat(sprintf("  %s %-26s est %-9.4f true %-8.3f %.2f SE\n", tag, what, est, true, z))
}

cat("\n=============== 1. LCA (poLCA) ===============\n")
suppressMessages(library(poLCA))
set.seed(20260929)
N1 <- 400; N2 <- 200; N <- N1 + N2
P1 <- c(.90, .85, .80, .88); P2 <- c(.15, .20, .10, .25)
mk <- function(n, p) sapply(p, function(pp) rbinom(n, 1, pp))
raw <- rbind(mk(N1, P1), mk(N2, P2))          # 0/1, as real data arrives
colnames(raw) <- paste0("q", 1:4)
items <- as.data.frame(raw)

# --- the plugin's own recode: categories to 1..K, by rank of observed value ---
d <- items
nm <- names(d); names(d) <- paste0("v", seq_along(d)); vv <- names(d)
maps <- list()
for (j in seq_along(d)) {
  v <- d[[j]]; lv <- sort(unique(v[!is.na(v)]))
  maps[[nm[j]]] <- as.character(lv); d[[j]] <- match(v, lv)
}
ok(all(sort(unique(unlist(d))) == c(1, 2)), "0/1 items are recoded to 1/2 (poLCA refuses 0)")
ok(identical(unname(unlist(maps)), c("0","1","0","1","0","1","0","1")),
   "the mapping kept for display is rank -> original code")

f <- as.formula(paste0("cbind(", paste(vv, collapse = ","), ") ~ 1"))
set.seed(12345)
fit1 <- poLCA(f, d, nclass = 1, nrep = 1,  verbose = FALSE, maxiter = 5000)
fit2 <- poLCA(f, d, nclass = 2, nrep = 10, verbose = FALSE, maxiter = 5000)

cat("\n-- exact identities --\n")
exact(sum(fit2$P), 1, "class shares sum to 1")
exact(fit2$aic, -2 * fit2$llik + 2 * fit2$npar, "AIC = -2logL + 2*npar")
exact(fit2$bic, -2 * fit2$llik + fit2$npar * log(N), "BIC = -2logL + npar*log(n)")
exact(nrow(fit2$posterior), N, "one posterior row per case")
exact(max(abs(rowSums(fit2$posterior) - 1)), 0, "every posterior row sums to 1", tol = 1e-8)
ok(all(fit2$predclass == apply(fit2$posterior, 1, which.max)),
   "predclass is the argmax of the posterior (what 'modal class' means)")
ok(all(sapply(fit2$probs, function(m) max(abs(rowSums(m) - 1))) < 1e-8),
   "each item's response probabilities sum to 1 within every class")
# 4 binary items => 2^4 - 1 = 15 df available; a 2-class model spends 9 parameters.
exact(fit2$npar, 2 * 4 + 1, "npar = k*items + (k-1) for binary indicators")
exact(fit2$resid.df, (2^4 - 1) - fit2$npar, "residual df = (cells-1) - npar")
ok(fit2$bic < fit1$bic, "BIC prefers 2 classes over 1 on 2-class data")

cat("\n-- recovery within sampling error --\n")
# poLCA labels classes arbitrarily; orient by which class has the high probability on item 1.
# probs[[item]] is a [class x category] matrix, so the high class is the argmax DOWN column 2
# (category 2 = the recoded "1"). The first version indexed across items and produced an item
# number where a class number was wanted.
hi <- which.max(fit2$probs[[1]][, 2])
lo <- 3 - hi
recov(fit2$P[hi], N1 / N, sqrt((N1/N) * (N2/N) / N), "share, high class")
recov(fit2$probs[[1]][hi, 2], P1[1], sqrt(P1[1] * (1 - P1[1]) / N1), "item1 P(1) | high class")
recov(fit2$probs[[1]][lo, 2], P2[1], sqrt(P2[1] * (1 - P2[1]) / N2), "item1 P(1) | low class")
recov(fit2$probs[[3]][hi, 2], P1[3], sqrt(P1[3] * (1 - P1[3]) / N1), "item3 P(1) | high class")

cat("\n-- hand-rolled entropy, against values known analytically --\n")
# `ct_entropy` is the one statistic here with no package behind it: neither poLCA nor flexmix
# reports relative entropy, and Mplus users expect it. So it is checked where the answer is
# certain rather than merely plausible.
ct_entropy <- function(post) {
  k <- ncol(post); if (is.null(k) || k < 2) return(NA_real_)
  p <- pmax(post, 1e-12); 1 - (-sum(post * log(p))) / (nrow(post) * log(k))
}
exact(ct_entropy(matrix(c(1,0, 1,0, 0,1), ncol = 2, byrow = TRUE)), 1,
      "perfect separation is exactly 1")
exact(ct_entropy(matrix(c(.5,.5, .5,.5), ncol = 2, byrow = TRUE)), 0,
      "a posterior carrying no information is exactly 0")
# Three classes, every row (.5, .5, 0): each row contributes ln 2, so E = 1 - ln2/ln3.
exact(ct_entropy(matrix(rep(c(.5,.5,0), 4), ncol = 3, byrow = TRUE)), 1 - log(2)/log(3),
      "a hand-computed three-class case (1 - ln2/ln3)")
ok(ct_entropy(fit2$posterior) > 0 && ct_entropy(fit2$posterior) < 1,
   "and a real posterior lands strictly between them")

cat("\n=============== 2. LPA (flexmix) ===============\n")
suppressMessages(library(flexmix))
set.seed(20260929)
M1 <- c(0, 0, 0); M2 <- c(3, 2.5, 3.5); n1 <- 300; n2 <- 200; n <- n1 + n2
X <- rbind(
  cbind(rnorm(n1, M1[1]), rnorm(n1, M1[2]), rnorm(n1, M1[3])),
  cbind(rnorm(n2, M2[1]), rnorm(n2, M2[2]), rnorm(n2, M2[3])))
colnames(X) <- c("anx", "dep", "som")
set.seed(12345)
fx <- flexmix(X ~ 1, k = 2, model = FLXMCmvnorm(diagonal = TRUE),
              control = list(iter.max = 1000, minprior = 0))

cat("\n-- exact identities --\n")
exact(sum(fx@prior), 1, "mixing proportions sum to 1")
# The plugin computes npar itself (flexmix does not expose it): k*(means + variances) + (k-1).
npar <- length(fx@prior) * (2 * ncol(X)) + fx@k - 1
exact(BIC(fx), -2 * as.numeric(logLik(fx)) + npar * log(n),
      "the plugin's npar reproduces flexmix's own BIC")
exact(AIC(fx), -2 * as.numeric(logLik(fx)) + 2 * npar, "...and its AIC")
post <- flexmix::posterior(fx)
exact(max(abs(rowSums(post) - 1)), 0, "every posterior row sums to 1", tol = 1e-8)
ok(all(flexmix::clusters(fx) == apply(post, 1, which.max)), "clusters() is the argmax of the posterior")
pars <- parameters(fx)
ok(sum(grepl("^center", rownames(pars))) == ncol(X),
   "exactly one center row per indicator (the rest are covariances, and must not be read as means)")

cat("\n-- recovery within sampling error --\n")
cen <- pars[grepl("^center", rownames(pars)), , drop = FALSE]
big <- which.max(colMeans(cen))   # component labels are arbitrary
sml <- 3 - big
for (j in seq_len(ncol(X))) {
  recov(cen[j, big], M2[j], 1 / sqrt(n2), sprintf("%s mean, raised profile", colnames(X)[j]))
  recov(cen[j, sml], M1[j], 1 / sqrt(n1), sprintf("%s mean, flat profile", colnames(X)[j]))
}
recov(fx@prior[big], n2 / n, sqrt((n1/n) * (n2/n) / n), "share, raised profile")

cat("\n=============== 3. Latent growth curve (lavaan) ===============\n")
suppressMessages(library(lavaan))
set.seed(20260929)
NG <- 400; MI <- 10; MS <- 1.5; VI <- 4; VS <- 0.36; RES <- 1
int <- rnorm(NG, MI, sqrt(VI)); slp <- rnorm(NG, MS, sqrt(VS))
w <- sapply(0:3, function(t) int + slp * t + rnorm(NG, 0, RES))
dw <- as.data.frame(w); names(dw) <- paste0("t", 1:4)
tt <- 0:3
mod <- paste0("i =~ ", paste(sprintf("1*%s", names(dw)), collapse = " + "), "\n",
              "s =~ ", paste(sprintf("%d*%s", tt, names(dw)), collapse = " + "))
g <- growth(mod, data = dw)
pe <- parameterEstimates(g)
fm <- fitMeasures(g, c("chisq", "df", "pvalue", "cfi", "tli", "rmsea", "srmr", "aic", "bic"))
# A MEAN row ("~1") carries an empty rhs, not a repeat of the lhs — defaulting rhs to lhs
# filtered every mean out and left NA to propagate into the identity checks.
getp <- function(o, l, r = if (o == "~1") "" else l) pe[pe$op == o & pe$lhs == l & pe$rhs == r, ]

cat("\n-- exact identities --\n")
ok(isTRUE(lavInspect(g, "converged")), "the model converged")
exact(lavInspect(g, "nobs"), NG, "n used is every case (no missing data here)")
# 4 occasions => 4 means + 10 (co)variances = 14 moments; the model spends 9.
exact(unname(fm["df"]), 14 - 9, "df = moments - free parameters")
exact(unname(fm["chisq"]) >= 0, TRUE, "chi-square is non-negative")
mi <- getp("~1", "i"); ms <- getp("~1", "s")
exact(mi$z, mi$est / mi$se, "z = est / se (intercept mean)")
exact(ms$z, ms$est / ms$se, "z = est / se (slope mean)")
# The loadings are FIXED, which is the whole claim of the model: they must not be estimated.
ld <- pe[pe$op == "=~", ]
ok(all(ld$se == 0 | is.na(ld$se)), "every loading is fixed, not estimated")
ok(all(ld$est[ld$lhs == "i"] == 1), "intercept loads 1 on every occasion")
ok(all(ld$est[ld$lhs == "s"] == tt), "slope loads 0, 1, 2, 3 — the assumed spacing")

cat("\n-- recovery within sampling error --\n")
recov(mi$est, MI, mi$se, "mean intercept")
recov(ms$est, MS, ms$se, "mean slope")
vi <- getp("~~", "i"); vs <- getp("~~", "s"); cv <- getp("~~", "i", "s")
recov(vi$est, VI, vi$se, "variance of intercept")
recov(vs$est, VS, vs$se, "variance of slope")
recov(cv$est, 0,  cv$se, "intercept-slope covariance")
ok(cv$pvalue > 0.05, "the covariance is correctly NOT significant (generated as zero)")

cat("\n==============================================\n")
if (fails == 0) cat("ALL CHECKS PASSED\n") else cat(sprintf("%d CHECK(S) FAILED\n", fails))
quit(status = if (fails == 0) 0 else 1)
