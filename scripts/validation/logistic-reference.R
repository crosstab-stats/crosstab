# Reference values for the Binary Logistic plugin's Options output (#178).
#
# The project rule is that a hand-rolled statistic gets diffed against the official
# library on desktop R. Three of the four things #178 added are hand-rolled — the
# Hosmer-Lemeshow test, SPSS's ZResid, and the Wald interval for Exp(B) — so this is
# that diff. It does NOT re-implement them: it runs the EXACT R the plugin emits,
# captured from the real builder, and compares that to the packages.
#
#   node scripts/validation/logistic-emit-r.mjs class,ci,hl,plot,casewise first LANGUAGE > emitted.R
#   "C:/Program Files/R/R-4.6.0/bin/Rscript.exe" scripts/validation/logistic-reference.R emitted.R
#
# Needs ResourceSelection (install.packages("ResourceSelection")). Everything else is
# base R, which is the point: the plugin carries no rPackages, so the Hosmer-Lemeshow
# arithmetic is hoslem.test's algorithm written out rather than its package.
#
# The data deliberately includes NAs in a predictor, so the casewise listing's claim —
# that "Case" is the DATASET row number and not glm's post-drop position — is actually
# under test rather than trivially true.

.libPaths(c("C:/Users/Ryan/R-libs", .libPaths()))
suppressMessages(library(ResourceSelection))

emitted <- commandArgs(trailingOnly = TRUE)[1]
if (is.na(emitted)) stop("usage: Rscript logistic-reference.R <emitted.R>")

set.seed(7)
n <- 500
LANGUAGE <- sample(c(1, 2, 3), n, TRUE, c(.5, .3, .2))
AGE <- rnorm(n, 40, 12)
lp <- -0.8 + 0.9 * (LANGUAGE == 2) + 0.4 * (LANGUAGE == 3) + 0.02 * AGE
SCHOOL_ATTEND <- ifelse(rbinom(n, 1, plogis(lp)) == 1, 2, 1)  # codes 1/2, like a .sav
AGE[c(9, 120, 400)] <- NA
df <- data.frame(SCHOOL_ATTEND = SCHOOL_ATTEND, LANGUAGE = LANGUAGE, AGE = AGE)

# Exactly what webr-manager's buildInputAliases() binds before the plugin's code runs.
dv <- df[["SCHOOL_ATTEND"]]
ivs <- df[c("LANGUAGE", "AGE")]
res <- eval(parse(text = paste(readLines(emitted, warn = FALSE), collapse = "\n")))

# An independent refit to compare against.
d2 <- data.frame(.y = as.integer(factor(dv, levels = sort(unique(dv)))) - 1L,
                 LANGUAGE = factor(df$LANGUAGE), AGE = df$AGE)
rownames(d2) <- seq_len(nrow(d2))
fit <- glm(.y ~ LANGUAGE + AGE, data = d2, family = binomial())
p <- fitted(fit); y <- fit$model$.y
co <- summary(fit)$coefficients

ok <- TRUE
report <- function(what, mine, ref, tol = 0) {
  d <- max(abs(as.numeric(mine) - as.numeric(ref)))
  if (!isTRUE(d <= tol)) ok <<- FALSE
  cat(sprintf("%-42s max|diff| = %.3e  %s\n", what, d, if (d <= tol) "OK" else "*** MISMATCH ***"))
}

cat("=== coefficients and the SPSS Wald interval for Exp(B) ===\n")
report("B vs glm", res$estimate, co[, 1])
report("Exp(B) lower vs exp(confint.default)", res$expbLo, exp(confint.default(fit))[, 1])
report("Exp(B) upper vs exp(confint.default)", res$expbHi, exp(confint.default(fit))[, 2])

cat("\n=== Hosmer-Lemeshow vs ResourceSelection::hoslem.test ===\n")
hl <- hoslem.test(y, p, g = 10)
report("chi-square", res$hlChisq, hl$statistic)
report("df", res$hlDf, hl$parameter)
report("p value", res$hlP, hl$p.value)
report("observed, outcome 0", res$hlO0, hl$observed[, "y0"])
report("observed, outcome 1", res$hlO1, hl$observed[, "y1"])
report("expected, outcome 0", res$hlE0, hl$expected[, "yhat0"])
report("expected, outcome 1", res$hlE1, hl$expected[, "yhat1"])
report("bins account for every case", sum(res$hlO0 + res$hlO1), nobs(fit))

cat("\n=== ZResid vs residuals(type = 'pearson') ===\n")
zr <- residuals(fit, type = "pearson")
report("listed cases' ZResid", res$cwZ, zr[as.character(res$cwRow)])
report("count beyond 2 SD", res$cwTotal, sum(abs(zr) > 2))
dropped <- any(res$cwRow %in% c(9, 120, 400))
if (dropped) ok <- FALSE
cat(sprintf("%-42s %s\n", "case numbers skip the NA rows",
            if (dropped) "*** MISMATCH ***" else "OK"))

cat("\n=== classification table vs base R at the .5 cut ===\n")
tb <- table(factor(y, 0:1), factor(as.integer(p >= .5), 0:1))
report("cells", c(res$ct00, res$ct01, res$ct10, res$ct11),
       c(tb[1, 1], tb[1, 2], tb[2, 1], tb[2, 2]))

cat("\n=== classification plot bins ===\n")
report("bin count", length(res$plBin), 20)
report("cases plotted", sum(res$plC0) + sum(res$plC1), nobs(fit))

cat("\n", if (ok) "ALL CHECKS PASSED\n" else "SOME CHECKS FAILED\n", sep = "")
quit(status = if (ok) 0 else 1)
