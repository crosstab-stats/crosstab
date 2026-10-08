# Reference values for the One-Way ANOVA plugin's SPSS-parity output.
#
# The project rule is that a hand-rolled statistic gets diffed against the official
# library on desktop R. Levene, Welch, Brown-Forsythe and the three effect sizes are all
# hand-rolled from weighted group Ns/means/variances (so that a frequency weight lands
# in the df), so this is that diff. It does NOT re-implement them: it runs the EXACT R
# the plugin emits, captured from the real source.
#
#   python scripts/validation/oneway-emit-r.py %TEMP%
#   "C:/Program Files/R/R-4.6.0/bin/Rscript.exe" scripts/validation/oneway-spss-parity.R %TEMP%
#
# Base R only, deliberately: the plugin declares no rPackages, so every one of these has
# to stand up against stats:: rather than against a package we would then have to ship.
#   classic F  -> oneway.test(var.equal = TRUE)       exact
#   Welch      -> oneway.test(var.equal = FALSE)      exact
#   Levene     -> an aov on |y - group mean|, built here from ave()/aov() so it is an
#                 independent construction rather than the plugin's own arithmetic
#   eta^2 etc. -> the SS from aov()
# Brown-Forsythe has no base-R implementation; it is checked against the identity that
# at k = 2 it coincides with Welch, and otherwise that its df2 stays inside (0, pooled].

SP <- commandArgs(trailingOnly = TRUE)[1]
run_plugin <- function(y_in, g_in) {
  e <- new.env()
  assign("y", y_in, envir = e); assign("g", g_in, envir = e)
  eval(parse(file.path(SP, "oneway_extracted.R")), envir = e)
}

ok <- TRUE
chk <- function(what, got, want, tol = 1e-9) {
  d <- abs(got - want)
  rel <- d / max(1e-12, abs(want))
  pass <- is.finite(d) && rel < tol
  if (!pass) ok <<- FALSE
  cat(sprintf("  %-34s %14.8f  vs %14.8f   %s\n", what, got, want, if (pass) "match" else "*** DIFFERS ***"))
}

set.seed(42)
for (case in list(
  list(tag = "balanced, equal variance, k=4", n = c(40, 40, 40, 40), mu = c(0, .4, .8, .2), sd = c(1, 1, 1, 1)),
  list(tag = "unbalanced, UNequal variance, k=4", n = c(15, 60, 25, 90), mu = c(0, .5, 1, .3), sd = c(1, 2.5, .6, 3)),
  list(tag = "k=2 (Brown-Forsythe == Welch)", n = c(35, 80), mu = c(0, .6), sd = c(1, 2.2))
)) {
  y <- unlist(lapply(seq_along(case$n), function(i) rnorm(case$n[i], case$mu[i], case$sd[i])))
  g <- factor(rep(LETTERS[seq_along(case$n)], case$n))
  r <- run_plugin(y, g)

  cat("\n== ", case$tag, " ==\n", sep = "")
  pooled <- oneway.test(y ~ g, var.equal = TRUE)
  chk("classic F", r$Fval, unname(pooled$statistic))
  chk("classic p", r$p, pooled$p.value)

  welch <- oneway.test(y ~ g, var.equal = FALSE)
  chk("Welch F", r$welF, unname(welch$statistic))
  chk("Welch df2", r$welDf2, unname(welch$parameter[2]))
  chk("Welch p", r$welP, welch$p.value)

  z <- abs(y - ave(y, g, FUN = mean))          # independent Levene reference
  lev <- summary(aov(z ~ g))[[1]]
  chk("Levene F (mean-centred)", r$levF, lev[1, "F value"])
  chk("Levene p", r$levP, lev[1, "Pr(>F)"])

  a <- summary(aov(y ~ g))[[1]]
  ssb <- a[1, "Sum Sq"]; ssw <- a[2, "Sum Sq"]; msw <- a[2, "Mean Sq"]; df1 <- a[1, "Df"]
  chk("eta^2", r$eta2, ssb / (ssb + ssw))
  chk("epsilon^2", r$eps2, (ssb - df1 * msw) / (ssb + ssw))
  chk("omega^2", r$om2, (ssb - df1 * msw) / (ssb + ssw + msw))

  if (nlevels(g) == 2) {
    chk("Brown-Forsythe F == Welch F", r$bfF, unname(welch$statistic))
    chk("Brown-Forsythe df2 == Welch", r$bfDf2, unname(welch$parameter[2]))
  } else {
    cat(sprintf("  %-34s F=%.6f df2=%.4f  (pooled df2=%.0f, Welch df2=%.4f)\n",
                "Brown-Forsythe", r$bfF, r$bfDf2, r$df2, r$welDf2))
    if (!(r$bfDf2 > 0 && r$bfDf2 <= r$df2)) { ok <<- FALSE; cat("   *** BF df2 outside (0, pooled df2] ***\n") }
  }
}

# CONTROLS. A validator that passes on data it was never given is not a validator — but
# the control has to test the right thing. Shifting a group changes its MEAN and not its
# spread, so Levene is *required* to sit still for that, and to react to a change in
# SPREAD. My first version asserted the opposite and "failed" correct code.
cat("\n== controls ==\n")
y <- rnorm(120); g <- factor(rep(c("A", "B", "C"), each = 40))
base <- run_plugin(y, g)

shifted <- y; shifted[g == "B"] <- shifted[g == "B"] + 3
sh <- run_plugin(shifted, g)
for (f in c("Fval", "welF", "bfF", "eta2", "eps2", "om2")) {
  if (!(abs(base[[f]] - sh[[f]]) > 1e-6)) { ok <- FALSE; cat(sprintf("  *** %s ignored a shifted group mean ***\n", f)) }
}
if (abs(base$levF - sh$levF) > 1e-9) { ok <- FALSE; cat("  *** Levene moved for a pure shift in MEAN ***\n") }
cat("  shifted a mean: F, Welch, Brown-Forsythe and the effect sizes reacted; Levene did not (correct)\n")

spread <- y; spread[g == "B"] <- spread[g == "B"] * 4
sp <- run_plugin(spread, g)
if (!(abs(base$levF - sp$levF) > 1e-6)) { ok <- FALSE; cat("  *** Levene ignored a change in spread ***\n") }
if (!(abs(base$welF - sp$welF) > 1e-6)) { ok <- FALSE; cat("  *** Welch ignored a change in spread ***\n") }
cat(sprintf("  changed a spread: Levene F %.3f -> %.3f, Welch F %.3f -> %.3f\n",
            base$levF, sp$levF, base$welF, sp$welF))
cat("\nRESULT:", if (ok) "ALL CHECKS PASSED\n" else "FAILURES ABOVE\n")
quit(status = if (ok) 0 else 1)
