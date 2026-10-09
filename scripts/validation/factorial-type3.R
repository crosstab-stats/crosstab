# Reference values for the Factorial ANOVA plugin's Type III output.
#
# The plugin used to report Type I (sequential) sums of squares while SPSS's UNIANOVA
# reports Type III. On a balanced design that distinction is invisible; on anything
# unbalanced — which is every real survey — it is not. A 2x2 on GSS-shaped data moved a
# main effect from 641 to 419, so a side-by-side comparison against SPSS would simply
# have disagreed, with nothing on either output to say why.
#
#   python scripts/validation/factorial-emit-r.py %TEMP%
#   "C:/Program Files/R/R-4.6.0/bin/Rscript.exe" scripts/validation/factorial-type3.R %TEMP%
#
# `car::Anova(type = 3)` is the usual authority and is not installed, so Type III is
# checked three ways that do not need it:
#
#   1. THE DEFINING PROPERTY. On a balanced design Type I, II and III coincide. The
#      plugin's numbers must equal base R's `anova()` exactly there.
#   2. THE DEFINITION ITSELF. For each term, Type III SS is the increase in residual sum
#      of squares when that term's columns alone are removed from the full design matrix
#      — built here by hand from model.matrix and lm.fit, which shares no code with
#      drop1. Checked on UNBALANCED data, where the three types differ.
#   3. The highest-order interaction is last in the sequence, so its Type I and Type III
#      SS are always equal — a free cross-check inside the unbalanced case.

SP <- commandArgs(trailingOnly = TRUE)[1]

run_plugin <- function(y, f1, f2) {
  e <- new.env()
  assign("dv", y, envir = e)
  assign("facs", list(a = f1, b = f2), envir = e)
  eval(parse(file.path(SP, "factorial_extracted.R")), envir = e)
}

ok <- TRUE
chk <- function(what, got, want, tol = 1e-8) {
  rel <- abs(got - want) / max(1e-12, abs(want))
  pass <- is.finite(rel) && rel < tol
  if (!pass) ok <<- FALSE
  cat(sprintf("  %-38s %14.7f  vs %14.7f   %s\n", what, got, want, if (pass) "match" else "*** DIFFERS ***"))
}

# Type III by its definition: drop one term's columns from the full design matrix.
type3_by_hand <- function(y, a, b) {
  op <- options(contrasts = c("contr.sum", "contr.poly"))
  d <- data.frame(y, a, b)
  X <- model.matrix(y ~ a * b, data = d)
  asn <- attr(X, "assign")          # 0 = intercept, 1 = a, 2 = b, 3 = a:b
  options(op)
  rss <- function(cols) sum(lm.fit(X[, cols, drop = FALSE], y)$residuals^2)
  full <- rss(seq_len(ncol(X)))
  out <- sapply(1:3, function(k) rss(which(asn != k)) - full)
  names(out) <- c("a", "b", "a:b")
  c(out, Error = full)
}

cat("== 1. balanced design: Type III must equal base R's Type I exactly ==\n")
set.seed(5); nb <- 50
yb <- rnorm(4 * nb, 10, 3)
ab <- factor(rep(c("m", "f"), each = 2 * nb))
bb <- factor(rep(c("us", "other"), times = 2 * nb))
rb <- run_plugin(yb, ab, bb)
seq1 <- anova(lm(yb ~ ab * bb))
for (i in 1:3) chk(paste("SS", rb$terms[i]), rb$ss[i], seq1[i, "Sum Sq"])
chk("Error SS", rb$ssRes, seq1[4, "Sum Sq"])

cat("\n== 2. UNBALANCED design: against Type III built by hand ==\n")
set.seed(3); n <- 200
a <- factor(sample(c("m", "f"), n, TRUE, prob = c(.65, .35)))
b <- factor(sample(c("us", "other"), n, TRUE, prob = c(.8, .2)))
y <- 10 + 2 * (a == "f") + 1.5 * (b == "other") + 3 * (a == "f") * (b == "other") + rnorm(n, 0, 4)
cat("   cell counts:", paste(as.vector(table(a, b)), collapse = " / "), "\n")
r <- run_plugin(y, a, b)
hand <- type3_by_hand(y, a, b)
for (i in 1:3) chk(paste("Type III SS", r$terms[i]), r$ss[i], unname(hand[i]))
chk("Error SS", r$ssRes, unname(hand[["Error"]]))

seqU <- anova(lm(y ~ a * b))
cat("   Type I, for contrast:", paste(sprintf("%.2f", seqU[1:3, "Sum Sq"]), collapse = " / "), "\n")
cat("   Type III           :", paste(sprintf("%.2f", r$ss), collapse = " / "), "\n")
if (abs(r$ss[1] - seqU[1, "Sum Sq"]) < 1e-6) {
  ok <- FALSE; cat("   *** the two types agree on unbalanced data — the switch did nothing ***\n")
}
cat("\n== 3. the last interaction is identical under both types ==\n")
chk("a:b Type III == Type I", r$ss[3], seqU[3, "Sum Sq"])

cat("\n== Levene across cells, against an independent aov ==\n")
cell <- interaction(a, b, drop = TRUE)
lv <- anova(lm(abs(y - ave(y, cell, FUN = mean)) ~ cell))
chk("Levene F", r$levF, lv[1, "F value"])
chk("Levene p", r$levP, lv[1, "Pr(>F)"])

cat("\n== cell descriptives ==\n")
chk("cells reported", length(r$cellName), nlevels(cell))
chk("first cell mean", r$cellMean[1], unname(tapply(y, cell, mean)[1]))
chk("grand mean", r$grandMean, mean(y))
chk("N", r$n, length(y))

cat("\n== Corrected Model ==\n")
mFit <- lm(y ~ a * b)
fs <- summary(mFit)$fstatistic
chk("Corrected Model F", r$fModel, unname(fs[1]))
chk("Corrected Model p", r$pModel, pf(fs[1], fs[2], fs[3], lower.tail = FALSE))
chk("Corrected Total SS", r$ssTot, sum((y - mean(y))^2))

cat("\nRESULT:", if (ok) "ALL CHECKS PASSED\n" else "FAILURES ABOVE\n")
quit(status = if (ok) 0 else 1)
