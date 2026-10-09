# Reference values for the Repeated-measures ANOVA plugin's sphericity output.
#
# The project rule is that a hand-rolled statistic gets diffed against the official
# library on desktop R. Almost nothing here IS hand-rolled — mauchly.test and anova.mlm
# are base stats and the plugin calls them — with one exception that forced the issue:
# anova.mlm COMPUTES the Greenhouse-Geisser and Huynh-Feldt epsilons and then exposes
# them only inside its printed heading, never as data. So the plugin computes those two
# itself, and this is the check that they are base R's numbers and not merely plausible
# ones.
#
#   python scripts/validation/sphericity-emit-r.py %TEMP%
#   "C:/Program Files/R/R-4.6.0/bin/Rscript.exe" scripts/validation/sphericity-reference.R %TEMP%
#
# The epsilons are parsed back out of that heading, which is the only place base R puts
# them. Parsing a print method is ugly; it is also the only way to compare against the
# authority rather than against a second copy of my own arithmetic.

SP <- commandArgs(trailingOnly = TRUE)[1]

run_plugin <- function(mat) {
  e <- new.env()
  assign("vars", as.data.frame(mat), envir = e)
  eval(parse(file.path(SP, "repeated_extracted.R")), envir = e)
}

ok <- TRUE
chk <- function(what, got, want, tol = 1e-6) {
  rel <- abs(got - want) / max(1e-12, abs(want))
  pass <- is.finite(rel) && rel < tol
  if (!pass) ok <<- FALSE
  cat(sprintf("  %-32s %13.7f  vs %13.7f   %s\n", what, got, want, if (pass) "match" else "*** DIFFERS ***"))
}

eps_from_heading <- function(a) {
  h <- paste(attr(a, "heading"), collapse = "\n")
  gg <- as.numeric(sub(".*Greenhouse-Geisser epsilon:\\s*([0-9.]+).*", "\\1", h))
  hf <- as.numeric(sub(".*Huynh-Feldt epsilon:\\s*([0-9.]+).*", "\\1", h))
  c(gg = gg, hf = hf)
}

set.seed(11)
for (case in list(
  list(tag = "k=4, clearly non-spherical", n = 60, sd = c(2, 3, 1.2, 4), mu = c(10, 11, 12, 11.5)),
  list(tag = "k=3, near-spherical",        n = 45, sd = c(2, 2.05, 1.95), mu = c(5, 5.4, 5.9)),
  list(tag = "k=5, small n",               n = 22, sd = c(1, 2, 1.5, 3, 2.5), mu = c(0, .5, 1, .7, 1.4))
)) {
  k <- length(case$sd)
  m <- sapply(seq_len(k), function(i) rnorm(case$n, case$mu[i], case$sd[i]))
  colnames(m) <- paste0("t", seq_len(k))
  r <- run_plugin(m)

  cat("\n== ", case$tag, " ==\n", sep = "")
  mlm <- lm(m ~ 1)
  idata <- data.frame(cond = factor(seq_len(k)))

  mau <- mauchly.test(mlm, X = ~1, idata = idata)
  chk("Mauchly W", r$mauW, unname(mau$statistic))

  a <- anova(mlm, X = ~1, idata = idata, test = "Spherical")
  e <- eps_from_heading(a)
  # The heading is printed to 4 significant figures, so that is the tolerance available.
  chk("Greenhouse-Geisser epsilon", round(r$ggE, 4), e[["gg"]], tol = 1e-3)
  # anova.mlm PRINTS the raw Huynh-Feldt estimate, which can exceed 1 (1.032 in the
  # near-spherical case); the plugin caps it at 1, as SPSS does, because an epsilon above
  # 1 is meaningless as a df multiplier. Base R agrees in substance even while printing
  # the raw value: its own H-F p for that case equals the uncorrected p exactly, which is
  # what capping at 1 produces.
  chk("Huynh-Feldt epsilon (capped)", round(r$hfE, 4), min(1, e[["hf"]]), tol = 1e-3)
  chk("G-G corrected p", r$ggP, a[1, "G-G Pr"])
  chk("H-F corrected p", r$hfP, a[1, "H-F Pr"])
  chk("uncorrected F", r$F, a[1, "F"])
  chk("uncorrected p", r$p, a[1, "Pr(>F)"])

  # Lower-bound is 1/(k-1) by definition, and its p follows from it.
  chk("Lower-bound epsilon", r$lbE, 1 / (k - 1))
  chk("Lower-bound p", r$lbP,
      pf(a[1, "F"], a[1, "num Df"] / (k - 1), a[1, "den Df"] / (k - 1), lower.tail = FALSE))

  # The corrections must never be more generous than the uncorrected test, and must
  # order themselves: lower-bound <= GG <= HF <= 1.
  if (!(r$lbE <= r$ggE + 1e-9 && r$ggE <= r$hfE + 1e-9 && r$hfE <= 1 + 1e-9)) {
    ok <- FALSE; cat("  *** epsilons out of order ***\n")
  }
  # "A correction makes the test harder to pass" is a statement about the CRITICAL
  # VALUE, and only about that. Shrinking the degrees of freedom always raises the .05
  # cut-off, which is the claim the plugin's footnote makes. It does NOT always raise
  # the p-value: with F near 1 the shape of the F distribution can move the tail the
  # other way, and two of the three cases here do exactly that (k=3: GG p .285676
  # against an uncorrected .2858654). I asserted the p-ordering first, then asserted it
  # "only when F > 1", and both versions failed correct code — the monotone thing is
  # the cut-off, so that is what gets checked.
  crit <- function(e) qf(.95, a[1, "num Df"] * e, a[1, "den Df"] * e)
  if (!(crit(r$lbE) >= crit(r$ggE) - 1e-9 && crit(r$ggE) >= crit(r$hfE) - 1e-9
        && crit(r$hfE) >= crit(1) - 1e-9)) {
    ok <- FALSE; cat("  *** a correction LOWERED the critical F ***\n")
  }
}

# CONTROL: two conditions cannot violate sphericity, so the plugin must report none
# rather than a W of 1 dressed up as a test.
cat("\n== control: k = 2 ==\n")
m2 <- cbind(rnorm(40, 0, 1), rnorm(40, .5, 2))
r2 <- run_plugin(m2)
if (!is.na(r2$mauW)) { ok <- FALSE; cat("  *** reported a sphericity test for two conditions ***\n") }
cat("  no sphericity test attempted (correct); F =", signif(r2$F, 6), "\n")

cat("\nRESULT:", if (ok) "ALL CHECKS PASSED\n" else "FAILURES ABOVE\n")
quit(status = if (ok) 0 else 1)
