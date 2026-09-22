# Demonstration of #186: builtin-epi's 2x2 is labelled backwards whenever the exposure
# or outcome is not coded 0/1 -- e.g. the 1 = Yes / 2 = No convention that GSS/SPSS
# data actually arrives in.
#
#   "C:/Program Files/R/R-4.6.0/bin/Rscript.exe" scripts/validation/epi-label-inversion.R
#
# Expected while the bug stands: the printed RR (0.222) is the risk ratio for the
# group the table calls UNexposed, while the label says 'Yes'. The correct RR for Yes
# is 4.500 -- harmful, not protective. Delete this file once #186 is fixed and the
# check lives in a test instead.

# builtin-epi's recoder, verbatim
bin01 <- function(v){ v <- suppressWarnings(as.numeric(v)); u <- sort(unique(v[is.finite(v)]))
  if (all(u %in% c(0,1))) return(v); if (length(u) == 2) return(as.integer(v == u[2])); rep(NA_integer_, length(v)) }

# A survey-coded exposure: 1 = Yes (exposed), 2 = No.  Value labels say so.
exposure <- c(1,1,1,1, 2,2,2,2,2,2)      # 4 exposed (Yes), 6 unexposed (No)
outcome  <- c(1,1,1,0, 0,0,0,0,0,1)      # 0/1 coded

e <- bin01(exposure)
cat("raw exposure :", exposure, "\n")
cat("bin01 output :", e, "\n")
cat("rows the plugin calls 'exposed' are raw code:", unique(exposure[e == 1]), "\n")
cat("...but the table labels that row with the value label of code '1' = 'Yes'\n\n")

a <- sum(e==1 & outcome==1); b <- sum(e==1 & outcome==0)
cc <- sum(e==0 & outcome==1); dd <- sum(e==0 & outcome==0)
cat(sprintf("printed 2x2:  a=%d b=%d c=%d d=%d\n", a,b,cc,dd))
cat(sprintf("printed RR = %.3f  (labelled as risk for 'Yes')\n", (a/(a+b))/(cc/(cc+dd))))

# What it SHOULD be, with Yes (code 1) as exposed
e2 <- as.integer(exposure == 1)
a2 <- sum(e2==1 & outcome==1); b2 <- sum(e2==1 & outcome==0)
c2 <- sum(e2==0 & outcome==1); d2 <- sum(e2==0 & outcome==0)
cat(sprintf("correct 2x2:  a=%d b=%d c=%d d=%d\n", a2,b2,c2,d2))
cat(sprintf("correct RR = %.3f\n", (a2/(a2+b2))/(c2/(c2+d2))))
