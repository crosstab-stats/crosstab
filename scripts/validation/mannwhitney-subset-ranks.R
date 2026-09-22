# Why Mann-Whitney must subset to the chosen pair BEFORE ranking (#187, Tier 4).
#
#   "C:/Program Files/R/R-4.6.0/bin/Rscript.exe" scripts/validation/mannwhitney-subset-ranks.R
#
# When a 3-group variable is compared two groups at a time, the third group's cases
# must not contribute ranks. This is only visible when the excluded group falls
# BETWEEN the two being tested -- if it sits entirely above or below them the
# within-pair ordering is unchanged and both orders agree, which is how such a bug
# survives a casual check. Here C is interleaved, and ranking first gives U1 = 41
# where the right answer is 0.

set.seed(9); n <- 30
# C now sits BETWEEN A and B, so ranks taken before subsetting really do differ.
g <- factor(rep(c("A","B","C"), each = n))
y <- c(rnorm(n, 10, 2), rnorm(n, 20, 2), rnorm(n, 15, 2))

sub <- g %in% c("A","B")
ya <- y[sub]; ga <- droplevels(g[sub])

# correct: rank AFTER subsetting
rk_after <- rank(ya)
n1 <- sum(ga=="A"); n2 <- sum(ga=="B")
R1_after <- sum(rk_after[ga=="A"]); U_after <- R1_after - n1*(n1+1)/2

# leaky: rank BEFORE subsetting (what you get if the subset is applied later)
rk_before <- rank(y)[sub]
R1_before <- sum(rk_before[ga=="A"]); U_before <- R1_before - n1*(n1+1)/2

cat(sprintf("rank after subset : R1 = %6.1f  U1 = %6.1f\n", R1_after, U_after))
cat(sprintf("rank before subset: R1 = %6.1f  U1 = %6.1f\n", R1_before, U_before))
cat("they differ:", !isTRUE(all.equal(U_after, U_before)), "\n")
ref <- wilcox.test(ya[ga=="A"], ya[ga=="B"], correct = FALSE)
cat(sprintf("wilcox.test W = %.1f -> the correct one is the AFTER value: %s\n",
            ref$statistic, isTRUE(all.equal(unname(ref$statistic), U_after))))
