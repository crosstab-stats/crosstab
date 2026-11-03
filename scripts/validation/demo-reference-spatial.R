# Reference values on the spatial demo (60 deterministic cases) for the battery-based
# analyses: reliability, factor/PCA, correlation matrix, ANOVA by district, regression.
# Base R only — psych is not installed locally, and alpha/PCA do not need it.

d <- read.csv("spatial.csv")
items <- d[, c("satisfaction", "commute_min", "income_k", "household_size")]

cat("=== shape ===\n")
cat("n =", nrow(d), " districts:", paste(names(table(d$district)), collapse = "/"),
    " counts:", paste(as.numeric(table(d$district)), collapse = "/"), "\n\n")

cat("=== DESCRIPTIVES (all four) ===\n")
for (v in names(items)) {
  x <- items[[v]]
  cat(sprintf("%-15s N=%d min=%g max=%g mean=%.4f sd=%.4f\n", v, length(x), min(x), max(x), mean(x), sd(x)))
}

cat("\n=== CORRELATION MATRIX (Pearson) ===\n")
print(round(cor(items), 6))

cat("\n=== RELIABILITY: Cronbach's alpha, 4 items ===\n")
# The standard formula; identical to psych::alpha's `raw_alpha`.
k <- ncol(items)
alpha_raw <- (k / (k - 1)) * (1 - sum(apply(items, 2, var)) / var(rowSums(items)))
# Standardised alpha works from the correlation matrix instead of the covariances.
r <- cor(items); rbar <- mean(r[upper.tri(r)])
alpha_std <- (k * rbar) / (1 + (k - 1) * rbar)
cat(sprintf("raw (covariance) alpha = %.6f\n", alpha_raw))
cat(sprintf("standardised alpha     = %.6f   (mean inter-item r = %.6f)\n", alpha_std, rbar))
cat("item-total correlations (item removed):\n")
for (v in names(items)) {
  rest <- rowSums(items[, setdiff(names(items), v), drop = FALSE])
  cat(sprintf("  %-15s r(item, rest) = %.6f\n", v, cor(items[[v]], rest)))
}
cat("alpha if item deleted:\n")
for (v in names(items)) {
  sub <- items[, setdiff(names(items), v), drop = FALSE]
  kk <- ncol(sub)
  a <- (kk / (kk - 1)) * (1 - sum(apply(sub, 2, var)) / var(rowSums(sub)))
  cat(sprintf("  without %-15s alpha = %.6f\n", v, a))
}

cat("\n=== FACTOR ANALYSIS / PCA, 4 items ===\n")
p <- prcomp(items, scale. = TRUE)
cat("eigenvalues (PCA on the correlation matrix, = SPSS 'Initial Eigenvalues'):\n")
print(round(p$sdev^2, 6))
cat("proportion of variance:\n")
print(round(p$sdev^2 / sum(p$sdev^2), 6))
cat("unrotated component loadings, first two components:\n")
load <- sweep(p$rotation[, 1:2], 2, p$sdev[1:2], "*")
print(round(load, 6))
cat("\nML factor analysis, 1 factor (stats::factanal):\n")
fa <- factanal(items, factors = 1)
print(round(fa$loadings[, 1], 6))
cat(sprintf("uniquenesses: %s\n", paste(round(fa$uniquenesses, 6), collapse = ", ")))
cat(sprintf("chi2=%.4f df=%d p=%.6f\n", fa$STATISTIC, fa$dof, fa$PVAL))

cat("\n=== ONE-WAY ANOVA: income_k by district ===\n")
print(summary(aov(income_k ~ district, data = d)))
cat("group means:\n"); print(round(tapply(d$income_k, d$district, mean), 4))

cat("\n=== LINEAR REGRESSION: income_k ~ satisfaction + commute_min + household_size ===\n")
m <- lm(income_k ~ satisfaction + commute_min + household_size, data = d)
print(summary(m))
cat("VIF (collinearity):\n")
for (v in c("satisfaction", "commute_min", "household_size")) {
  f <- as.formula(paste(v, "~ ."))
  r2 <- summary(lm(f, data = d[, c("satisfaction", "commute_min", "household_size")]))$r.squared
  cat(sprintf("  %-15s VIF = %.6f\n", v, 1 / (1 - r2)))
}

cat("\n=== K-MEANS, k=3, on the 4 standardised items ===\n")
# k-means depends on the starting assignment, so this is a SHAPE check, not an exact one.
set.seed(42)
km <- kmeans(scale(items), centers = 3, nstart = 25)
cat("cluster sizes:", paste(sort(km$size), collapse = "/"), "\n")
cat(sprintf("total SS=%.4f  within SS=%.4f  between/total=%.6f\n",
            km$totss, km$tot.withinss, km$betweenss / km$totss))

cat("\n=== CROSSTAB: district x household_size (chi-square) ===\n")
t <- table(d$district, d$household_size); print(t)
cs <- suppressWarnings(chisq.test(t))
cat(sprintf("chi2=%.4f df=%d p=%.6f  Cramer's V=%.6f\n", cs$statistic, cs$parameter, cs$p.value,
            sqrt(as.numeric(cs$statistic) / (sum(t) * (min(dim(t)) - 1)))))
