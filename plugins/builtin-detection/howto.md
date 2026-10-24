# builtin-detection - how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.
#
# One physical line per paragraph and per list item: the how-to renderer joins a
# paragraph's lines with <br> and runs the inline pass per line, so a wrapped link
# renders as literal brackets, and a list block needs every line to start with a bullet.

--- id: detection-distance
Every survey misses things, and the further away they are the more it misses. Distance sampling measures that fall-off and corrects the count for it.

**Ecology ▸ Distance sampling…** wants one row per detected object and one column holding how far away it was — perpendicular from the line for a line transect, radial from the observer for a point count.

1. **Pick the distance column** and say whether it was a **line** or a **point** survey. The two divide the searched area differently, so this is not cosmetic.
2. **Choose a detection function.** Half-normal is the usual starting point; hazard-rate allows a flatter shoulder near zero; uniform with a cosine adjustment is the third standard model. Run all three and compare AIC — the lowest wins, and if they disagree about density by a lot, say so in your write-up.
3. **Set a truncation distance** if the tail is sparse. Leaving it at 0 uses the largest distance you observed, which lets one very distant detection stretch the function. Discarding the farthest 5–10% is normal practice.
4. **Give the effort** to get density: total line length for a line survey, or the number of point visits for a point survey. Add a study area to turn density into abundance.

**What the output means.** **p̂** is the chance an object inside the truncation width was detected at all. The **effective strip width** (or **effective detection radius** for a point) is the distance at which a perfect detector would have found exactly as many — it is what converts your effort into an area actually searched, and so it is what density divides by.

**Three assumptions carry the estimate, and none of them is visible in the output.** Everything on the line or point is detected, so p = 1 at distance zero. Nothing moves in response to you before you detect it — birds that flush and deer that step back both break this. And distances are measured rather than estimated by eye; eyeballed distances pile up on round numbers and bend the function.

Fewer than about 60 detections and the shape of the function is poorly determined no matter how exact the arithmetic looks. The result says so when that happens.

A bare uniform detection function is not offered. It fits, and it reports p = 1 and an abundance exactly equal to the raw count — which is the assumption this analysis exists to avoid.

--- id: detection-occupancy
If you visit a site and find nothing, you have learned one of two things and you cannot tell which: the species was absent, or it was there and you missed it. Occupancy models separate them, and the only thing that makes it possible is **visiting the same sites more than once**.

**Ecology ▸ Occupancy / N-mixture…** wants one row per site and one column per visit.

- **Occupancy** asks whether the species was present, from detection/non-detection data. It estimates **ψ** (the proportion of sites occupied) and **p** (the chance of detecting it on one visit, given presence).
- **N-mixture** asks how many were there, from counts. It estimates **λ** (mean abundance per site) and **p**.

**Read the second table first.** The naive figure — the proportion of sites where you ever detected the species — is a floor, not an estimate, because it counts no site you missed everywhere. The model reads the pattern *across* visits: a site where you detected on the second visit but not the first proves a miss is possible, and how often that happens tells you how many all-miss sites there must be. The difference between the two numbers is the result.

**Where the information comes from.** Detection is estimated from sites where you detected at least once, and then applied to the sites where you never did. So a species detected on nearly every visit leaves little to correct, and the model will agree with the naive figure — which is the right answer, and a good check that nothing is wrong.

**What breaks it.** Both models assume the sites are **closed** over the visits — nothing arrives or leaves between them — so visits spread across a season can estimate "detection" that is really colonisation. They assume detections are **independent** between visits, which a tracking dog or a returning observer can break. And they assume the sites are comparable; if half are good habitat and half are not, a single ψ averages two different things.

**N-mixture needs a K**, the largest plausible abundance at any site. The default adds a generous margin to your biggest count. Re-run with a larger K and check the estimate holds still — if it drifts upward with K, the model is not identified from your data and λ should not be quoted.

Count columns fed to the **occupancy** model are read as presence/absence, because that is what the model is. Use N-mixture if the counts themselves matter.

**How these are computed.** The usual R package for them, `unmarked`, has no WebAssembly build — it is listed in the WebR package index but the binary is not there — so CrossTab computes both likelihoods directly: MacKenzie et al. (2002) for occupancy, Royle (2004) for the N-mixture model, maximised with `optim` and standard errors from the numerical Hessian. Both were checked against `unmarked` on desktop R: occupancy agrees to ten decimal places including the standard errors, and the N-mixture AIC agrees to seven with the abundance estimate about 0.0002 apart, which is the two optimisers stopping at slightly different points on the same curve.

A missing confidence interval means the Hessian was singular — usually an estimate sitting on a boundary, like an occupancy of exactly 1. The estimate is still shown; the interval is withheld rather than invented.
