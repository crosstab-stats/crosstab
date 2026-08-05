# Reference values for the SCED plugin (single-case experimental design).
#
# `scan` CANNOT run in WebR — not because any one package is broken, but because its
# dependency tree needs more concurrently-loaded shared objects than the WASM build
# allows (see the #SCED TODO entry). So the statistics have to be hand-rolled, and this
# script is how we satisfy the project rule about validating hand-rolled work against
# the official library: run it on desktop R and diff the numbers.
#
#   "C:/Program Files/R/R-4.6.0/bin/Rscript.exe" scripts/validation/sced-reference.R
#
# The data deliberately OVERLAPS between phases. Clean separation saturates every
# non-overlap statistic at 100 and would let a wrong implementation pass.

.libPaths(c("C:/Users/Ryan/R-libs", .libPaths()))
suppressMessages(library(scan))
# Deliberate OVERLAP so every statistic is discriminating, not saturated at 100.
a <- scdf(c(A = 5, 7, 6, 8,  B = 7, 9, 8, 11, 10), name = "Ann")
b <- scdf(c(A = 4, 6, 5, 7, 5,  B = 6, 5, 9, 8), name = "Ben")
d <- c(a, b)
n <- nap(d)$nap
cat("NAP\n"); print(n[, c("Case","NAP","Pairs","Non-overlaps","Positives","Ties","p")], digits=10)
cat("\nPND\n"); print(pnd(d)$PND)
cat("\nIRD\n"); print(ird(d))
tu <- tau_u(d, method="complete")
cat("\nTAU-U table names:", paste(names(tu$table), collapse=" | "), "\n")
for (nm in names(tu$table)) { cat("--", nm, "\n"); print(round(tu$table[[nm]], 6)) }
