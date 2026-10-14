# builtin-sem — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: sem-cfa
Tests a factor structure you already have in mind, rather than [discovering one](howto:factor-analysis).

**Analyze ▸ Multivariate ▸ Confirmatory factor analysis…**, then pick the **items** for one factor and optionally name it.

You get standardised loadings and the fit indices — χ², **CFI**, **TLI**, **RMSEA**, **SRMR**. χ² is sensitive to sample size and will reject a good model on a large sample, which is why the others exist; report several rather than picking the flattering one.

Good fit says the data is *consistent with* your structure. It does not say the structure is the only one that would fit, and typically several would.

Syntax:

`run builtin-sem.cfa {"items": ["x1", "x2", "x3"], "factorName": "Factor"}`

--- id: sem-growth
Models **change over time** as a latent trajectory: an intercept (where people start) and a slope (how fast they move), each with its own variance across individuals.

**Analyze ▸ Multivariate ▸ Latent growth curve…**

The variances are usually the interesting part. A significant slope variance says people changed at genuinely different rates — which is a different and often more useful finding than the average rate of change, and one that an average alone conceals.

[A multilevel model](howto:multilevel-linear) can express much the same thing in long format; this is the structural-equation route, in wide.

--- id: sem-model
The general case: write the model in **lavaan syntax** and fit it.

**Analyze ▸ Multivariate ▸ Structural equation model (syntax)…**, then pick every variable the model uses and write the **model** string, equations separated by `;`:

- `f1 =~ x1 + x2` — a latent factor measured by those items;
- `y ~ x` — a regression path;
- `f1 ~~ f2` — a covariance.

You get standardised estimates and the fit indices.

Fit indices judge how well the model reproduces the covariances; they say nothing about whether the arrows point the right way. Several quite different causal stories imply the same covariance structure, and all of them will fit identically. For the common three-variable case, [mediation](howto:mediation-indirect) is the shorter route.

Syntax:

`run builtin-sem.sem {"vars": ["x1", "x2", "x3", "x4"], "model": "f1 =~ x1+x2 ; f2 =~ x3+x4 ; f1 ~~ f2"}`
