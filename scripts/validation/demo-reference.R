# Authoritative reference values for the CrossTab demo dataset (30 deterministic cases).
# Run on desktop R 4.6.0. Every number printed here goes into docs/TESTING.md as the
# expected result, so the owner can check arithmetic without opening SPSS at all.

d <- read.csv("demo.csv")
# income carries SPSS-style user-missing codes; CrossTab recodes them to NA before any
# analysis, so the reference must too, or every income statistic will disagree.
d$income[d$income %in% c(-99, -98)] <- NA

cat("=== 0. shape ===\n")
cat("n rows:", nrow(d), " income valid:", sum(!is.na(d$income)),
    " income missing:", sum(is.na(d$income)), "\n\n")

cat("=== 1. FREQUENCIES: gender, education, region ===\n")
for (v in c("gender", "education", "region")) {
  t <- table(d[[v]])
  p <- round(100 * as.numeric(t) / sum(t), 1)
  cat(v, ": codes", paste(names(t), collapse = "/"),
      " counts", paste(as.numeric(t), collapse = "/"),
      " pct", paste(p, collapse = "/"), "\n")
}

cat("\n=== 2. FREQUENCIES statistics panel, age ===\n")
a <- d$age
mode_of <- function(x) { t <- table(x); as.numeric(names(t)[t == max(t)]) }
cat("n", length(a), " mean", round(mean(a), 4), " median", median(a),
    " mode", paste(mode_of(a), collapse = ","), " sum", sum(a), "\n")
cat("sd", round(sd(a), 4), " var", round(var(a), 4),
    " se", round(sd(a) / sqrt(length(a)), 4),
    " range", diff(range(a)), " min", min(a), " max", max(a), "\n")
# SPSS FREQUENCIES quartiles = its own definition; R type 6 is the match (not the default 7).
cat("quartiles type6 (SPSS):", paste(round(quantile(a, c(.25, .5, .75), type = 6), 4), collapse = " / "), "\n")
cat("quartiles type7 (R default):", paste(round(quantile(a, c(.25, .5, .75), type = 7), 4), collapse = " / "), "\n")

cat("\n=== 3. DESCRIPTIVES: age, income ===\n")
for (v in c("age", "income")) {
  x <- d[[v]][!is.na(d[[v]])]
  cat(sprintf("%s: N=%d min=%g max=%g mean=%.4f sd=%.4f\n",
              v, length(x), min(x), max(x), mean(x), sd(x)))
}

cat("\n=== 4. EXPLORE: 95% CI for the mean ===\n")
for (v in c("age", "income")) {
  x <- d[[v]][!is.na(d[[v]])]
  ci <- t.test(x)$conf.int
  cat(sprintf("%s: mean=%.4f  95%% CI [%.4f, %.4f]\n", v, mean(x), ci[1], ci[2]))
}

cat("\n=== 5. CROSSTABS gender x education ===\n")
tab <- table(d$gender, d$education)
print(tab)
cs <- chisq.test(tab)                       # no correction: 2x3
cat(sprintf("Pearson chi2=%.4f df=%d p=%.4f\n", cs$statistic, cs$parameter, cs$p.value))
cat("expected counts:\n"); print(round(cs$expected, 4))
n <- sum(tab)
cat(sprintf("Cramer's V=%.4f  Phi=%.4f\n",
            sqrt(as.numeric(cs$statistic) / (n * (min(dim(tab)) - 1))),
            sqrt(as.numeric(cs$statistic) / n)))
lr <- 2 * sum(ifelse(tab > 0, tab * log(tab / cs$expected), 0))
cat(sprintf("Likelihood-ratio chi2=%.4f p=%.4f\n", lr, pchisq(lr, cs$parameter, lower.tail = FALSE)))

cat("\n=== 5b. CROSSTABS 2x2 (gender x highschool-vs-higher) for the corrected chi2 ===\n")
hs <- ifelse(d$education == 1, 1, 2)
t2 <- table(d$gender, hs); print(t2)
cat(sprintf("Pearson (no corr) chi2=%.4f p=%.4f\n",
            chisq.test(t2, correct = FALSE)$statistic, chisq.test(t2, correct = FALSE)$p.value))
cat(sprintf("Yates continuity-corrected chi2=%.4f p=%.4f\n",
            chisq.test(t2, correct = TRUE)$statistic, chisq.test(t2, correct = TRUE)$p.value))
cat(sprintf("Fisher exact p=%.4f  OR=%.4f\n",
            fisher.test(t2)$p.value, fisher.test(t2)$estimate))

cat("\n=== 6. INDEPENDENT t-TEST: income by gender ===\n")
g1 <- d$income[d$gender == 1 & !is.na(d$income)]
g2 <- d$income[d$gender == 2 & !is.na(d$income)]
cat(sprintf("group1 (Male)   n=%d mean=%.4f sd=%.4f\n", length(g1), mean(g1), sd(g1)))
cat(sprintf("group2 (Female) n=%d mean=%.4f sd=%.4f\n", length(g2), mean(g2), sd(g2)))
pe <- t.test(g1, g2, var.equal = TRUE)
pw <- t.test(g1, g2, var.equal = FALSE)
cat(sprintf("equal var:   t=%.4f df=%g p=%.4f  CI [%.3f, %.3f]\n",
            pe$statistic, pe$parameter, pe$p.value, pe$conf.int[1], pe$conf.int[2]))
cat(sprintf("Welch:       t=%.4f df=%.4f p=%.4f  CI [%.3f, %.3f]\n",
            pw$statistic, pw$parameter, pw$p.value, pw$conf.int[1], pw$conf.int[2]))
# Levene's: SPSS centres on the MEAN, car::leveneTest defaults to the MEDIAN.
sub <- d[!is.na(d$income), ]
lev_mean <- function(y, g) {
  g <- factor(g); z <- abs(y - tapply(y, g, mean)[g])
  anova(lm(z ~ g))[1, c("F value", "Pr(>F)")]
}
lm_ <- lev_mean(sub$income, sub$gender)
cat(sprintf("Levene (mean-centred, = SPSS): F=%.4f p=%.4f\n", lm_[[1]], lm_[[2]]))

cat("\n=== 7. ONE-WAY ANOVA: income by education ===\n")
fit <- aov(income ~ factor(education), data = sub)
print(summary(fit))
cat("group means:\n"); print(round(tapply(sub$income, sub$education, mean), 4))
lo <- lev_mean(sub$income, sub$education)
cat(sprintf("Levene (mean-centred, = SPSS): F=%.4f p=%.4f\n", lo[[1]], lo[[2]]))

cat("\n=== 8. CORRELATION: age, income ===\n")
cp <- cor.test(d$age, d$income, method = "pearson")
cs2 <- cor.test(d$age, d$income, method = "spearman")
ck <- cor.test(d$age, d$income, method = "kendall")
cat(sprintf("Pearson  r=%.4f p=%.4f n=%d  CI [%.4f, %.4f]\n",
            cp$estimate, cp$p.value, sum(complete.cases(d$age, d$income)),
            cp$conf.int[1], cp$conf.int[2]))
cat(sprintf("Spearman rho=%.4f p=%.4f\n", cs2$estimate, cs2$p.value))
cat(sprintf("Kendall tau-b=%.4f p=%.4f\n", ck$estimate, ck$p.value))

cat("\n=== 9. LINEAR REGRESSION: income ~ age + education ===\n")
r1 <- lm(income ~ age + education, data = d)
print(summary(r1))
cat("ANOVA table:\n"); print(anova(r1))

cat("\n=== 10. BINARY LOGISTIC: gender(2=Female modelled) ~ age + income ===\n")
d$female <- ifelse(d$gender == 2, 1, 0)
lg <- glm(female ~ age + income, data = d, family = binomial)
print(summary(lg))
cat("odds ratios:\n"); print(round(exp(coef(lg)), 6))
cat(sprintf("-2LL=%.4f  null dev=%.4f  AIC=%.4f  n=%d\n",
            lg$deviance, lg$null.deviance, lg$aic, length(lg$fitted.values)))

cat("\n=== 11. NONPARAMETRIC ===\n")
mw <- wilcox.test(g1, g2, exact = FALSE, correct = TRUE)
cat(sprintf("Mann-Whitney U (normal approx, corrected): W=%g p=%.4f\n", mw$statistic, mw$p.value))
cat(sprintf("Mann-Whitney exact: p=%.4f\n", wilcox.test(g1, g2, exact = TRUE)$p.value))
kw <- kruskal.test(income ~ factor(education), data = sub)
cat(sprintf("Kruskal-Wallis chi2=%.4f df=%d p=%.4f\n", kw$statistic, kw$parameter, kw$p.value))
wsr <- wilcox.test(d$age, d$income / 1000, paired = TRUE, exact = FALSE)
cat(sprintf("Wilcoxon signed-rank (age vs income/1000): V=%g p=%.4f\n", wsr$statistic, wsr$p.value))

cat("\n=== 12. CHI-SQUARE GOODNESS OF FIT: region, equal expected ===\n")
gof <- chisq.test(table(d$region))
cat(sprintf("chi2=%.4f df=%d p=%.4f  observed %s\n", gof$statistic, gof$parameter,
            gof$p.value, paste(as.numeric(table(d$region)), collapse = "/")))

cat("\n=== 13. ONE-SAMPLE t-TEST: age vs mu=40 ===\n")
o <- t.test(d$age, mu = 40)
cat(sprintf("t=%.4f df=%d p=%.4f mean=%.4f CI [%.4f, %.4f]\n",
            o$statistic, o$parameter, o$p.value, mean(d$age), o$conf.int[1], o$conf.int[2]))

cat("\n=== 14. ONE-PROPORTION: gender==2 vs p0=0.5 ===\n")
k <- sum(d$gender == 2)
cat(sprintf("k=%d n=%d  exact binomial p=%.4f   prop.test (corrected) p=%.4f\n",
            k, nrow(d), binom.test(k, nrow(d), 0.5)$p.value,
            prop.test(k, nrow(d), 0.5)$p.value))

cat("\n=== 15. RELIABILITY-style: correlation matrix of age/income (for Cronbach sanity) ===\n")
print(round(cor(d[, c("age", "income")], use = "complete.obs"), 6))
