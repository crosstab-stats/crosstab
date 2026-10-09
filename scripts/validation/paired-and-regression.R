# Reference values for the two smaller SPSS-parity additions:
#   - the Paired Samples Correlations table on the paired t-test
#   - the ANOVA table and Std. Error of the Estimate on linear regression
#
# Both are small enough that the temptation is to eyeball them. The project rule is that
# a hand-rolled statistic gets diffed against the official library on desktop R, and the
# weighted correlation IS hand-rolled — R's cov() takes no frequency weights — so it
# gets the same treatment as the rest.
#
#   "C:/Program Files/R/R-4.6.0/bin/Rscript.exe" scripts/validation/paired-and-regression.R
#
# Unlike the other references in this directory these two formulas are short enough to
# state inline rather than extracted from the plugin; what matters is that they are
# checked against cor.test / summary.lm / anova, and against CASE EXPANSION for the
# weighted form — with an integer weight, a weighted figure must equal the unweighted
# figure computed on the physically replicated data, which is the standard this project
# already holds its weighted statistics to.

ok <- TRUE
chk <- function(what, got, want, tol = 1e-9) {
  rel <- abs(got - want) / max(1e-12, abs(want))
  pass <- is.finite(rel) && rel < tol
  if (!pass) ok <<- FALSE
  cat(sprintf("  %-36s %14.8f  vs %14.8f   %s\n", what, got, want, if (pass) "match" else "*** DIFFERS ***"))
}

# --- the plugin's weighted correlation, as written in builtin-compare ---------
wmean <- function(x, w) if (all(w == 1)) mean(x) else sum(w * x) / sum(w)
wvar <- function(x, w) {
  if (all(w == 1)) return(var(x))
  n <- sum(w); m <- sum(w * x) / n; sum(w * (x - m)^2) / (n - 1)
}
pair_r <- function(x1, x2, w) {
  n <- sum(w)
  v1 <- wvar(x1, w); v2 <- wvar(x2, w)
  cov12 <- if (all(w == 1)) cov(x1, x2) else
    sum(w * (x1 - wmean(x1, w)) * (x2 - wmean(x2, w))) / (n - 1)
  r <- cov12 / sqrt(v1 * v2)
  tt <- r * sqrt((n - 2) / (1 - r^2))
  c(r = r, p = 2 * pt(-abs(tt), n - 2))
}

set.seed(19)
n <- 120
x1 <- rnorm(n, 12, 3)
x2 <- 0.7 * x1 + rnorm(n, 4, 2)          # genuinely correlated, as a paired design is

cat("== Paired Samples Correlations, unweighted ==\n")
got <- pair_r(x1, x2, rep(1, n))
ct <- cor.test(x1, x2)
chk("r", got[["r"]], unname(ct$estimate))
chk("Sig.", got[["p"]], ct$p.value)

cat("\n== weighted, against CASE EXPANSION ==\n")
w <- sample(1:3, n, TRUE)
gotW <- pair_r(x1, x2, w)
ex1 <- rep(x1, w); ex2 <- rep(x2, w)     # the same data, physically replicated
ctE <- cor.test(ex1, ex2)
chk("weighted r", gotW[["r"]], unname(ctE$estimate))
chk("weighted Sig.", gotW[["p"]], ctE$p.value)

cat("\n== regression: ANOVA table and Std. Error of the Estimate ==\n")
y <- 3 + 1.8 * x1 + rnorm(n, 0, 5)
fit <- lm(y ~ x1)
s <- summary(fit)
a <- anova(fit)
fitv <- fitted(fit); res <- resid(fit)
ssReg <- sum((fitv - mean(fitv))^2); ssRes <- sum(res^2)
chk("Regression SS", ssReg, a[1, "Sum Sq"])
chk("Residual SS", ssRes, a[2, "Sum Sq"])
chk("Total SS", ssReg + ssRes, sum((y - mean(y))^2))
chk("Regression MS", ssReg / s$fstatistic[2], a[1, "Mean Sq"])
chk("Residual MS", ssRes / s$fstatistic[3], a[2, "Mean Sq"])
chk("F", unname(s$fstatistic[1]), a[1, "F value"])
chk("Std. Error of the Estimate", s$sigma, sqrt(a[2, "Mean Sq"]))

cat("\n== controls ==\n")
# A correlation of a variable with itself is 1; with pure noise it is near 0. A formula
# that cannot tell those apart is not measuring association.
chk("r(x, x) == 1", pair_r(x1, x1, rep(1, n))[["r"]], 1)
noise <- pair_r(x1, rnorm(n), rep(1, n))[["r"]]
if (abs(noise) > 0.3) { ok <- FALSE; cat("  *** r with pure noise came out at", noise, "***\n") }
cat(sprintf("  r with pure noise %.4f (near zero)\n", noise))
# And the weighted form must NOT equal the unweighted one on non-constant weights,
# or the weight is being ignored.
if (abs(gotW[["r"]] - got[["r"]]) < 1e-9) {
  ok <- FALSE; cat("  *** weighting changed nothing — the weight is being ignored ***\n")
}
cat(sprintf("  unweighted r %.6f vs weighted %.6f (the weight does something)\n",
            got[["r"]], gotW[["r"]]))

cat("\nRESULT:", if (ok) "ALL CHECKS PASSED\n" else "FAILURES ABOVE\n")
quit(status = if (ok) 0 else 1)
