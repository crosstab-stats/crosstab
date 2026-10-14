# builtin-spatial — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: spatial-autocorrelation
Are nearby places alike? Moran's I tests whether a value clusters geographically rather than being scattered at random.

**Analyze ▸ Spatial ▸ Spatial autocorrelation (Moran's I)…**, then set:

- **value** — the measure;
- **xcoord** / **ycoord** — longitude and latitude;
- **k** — how many nearest neighbours define "nearby" (default 4).

You get Moran's I and Geary's C.

**k is a modelling choice, not a detail.** It defines what counts as a neighbour, and the answer can change with it — so report the k you used, and check whether the conclusion survives a different one.

Spatial clustering also matters for ordinary analyses: if your observations are geographically correlated, they are not independent, and [a spatial lag model](howto:spatial-lag) is the regression that accounts for it.

Syntax:

`run builtin-spatial.autocorrelation {"value": "rate", "xcoord": "lon", "ycoord": "lat", "k": 4}`

--- id: spatial-lag
Regression that allows a place's outcome to depend on its neighbours' outcomes.

**Analyze ▸ Spatial ▸ Spatial lag regression…**, then set the **outcome**, the **preds**, the coordinate columns and **k** (default 5).

Use it when [Moran's I](howto:spatial-autocorrelation) says the outcome clusters. Ordinary regression on spatially correlated data understates the standard errors for the same reason clustered data does — the observations are not independent, and the model is entitled to less confidence than it reports.

Syntax:

`run builtin-spatial.lagregression {"outcome": "price", "preds": ["rooms", "age"], "xcoord": "lon", "ycoord": "lat", "k": 5}`

--- id: spatial-choropleth
A shaded map: one colour per region, driven by a value.

**Analyze ▸ Spatial ▸ Choropleth map…**, then set the **region** key column, the **value** to shade, a **boundary** GeoJSON file and the **keyprop** — the property in that file the region key matches.

Nearly all the difficulty is in that last pair: the region ids in your data must match the ids inside the boundary file exactly, and survey data rarely arrives with them at all.

**If your data has coordinates but no region id**, the Map layers workspace can produce one: **Load boundaries…**, then **Assign regions…** matches every case to the region whose shape contains its longitude and latitude, and writes a new dataset with a region-id column. Point-in-polygon, on your device — no service and no API key.

Syntax:

`run builtin-spatial.choropleth {"region": "GEOID", "value": "rate", "boundary": "counties.geojson", "keyprop": "GEOID"}`
