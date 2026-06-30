/**
 * @file plugins/builtin-textanalytics/index.js
 * Built-in plugin: **Text analytics** (qualitative Tier 1) — the first
 * first-class qualitative tool in CrossTab. Computational/content-analysis
 * techniques over a free-text column (open-ended survey responses, interview
 * transcripts, field notes, social-media posts):
 *
 *  - **Word frequency** — tokenize, drop stop-words, rank the most common terms
 *    (table + bar chart).
 *  - **Sentiment analysis** — Bing lexicon polarity (net sentiment + the words
 *    driving it), optionally per document/group.
 *  - **TF-IDF** — the terms most distinctive of each document/group.
 *  - **Keyword in context (KWIC)** — every occurrence of a search term with its
 *    surrounding words (a concordance), the bread-and-butter of close reading.
 *
 * Tokenization, stop-words and lexicons come from **tidytext** (+ dplyr); KWIC
 * is base R. This is computational text analysis — the interpretive
 * code-the-transcript workspace is the separate CAQDAS build (Tier 3).
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-textanalytics',
  name: 'Text analytics',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Text',
  keywords: ['text', 'qualitative', 'tidytext', 'word frequency', 'sentiment', 'tf-idf', 'kwic', 'concordance', 'content analysis', 'nlp'],
  disciplines: ['Sociology', 'Anthropology', 'Ethnic Studies', "Women's & Gender Studies", 'Asian Studies', 'Communication'],
  howto:
    'GUI: Text ▸ Word frequency… / Sentiment analysis… / TF-IDF… / Keyword in context…, then pick a free-text column. You get word counts, polarity scores, distinctive terms, or a concordance.\n' +
    'Syntax: run builtin-textanalytics.wordFrequency {"text": "response", "stopwords": "remove", "topn": 25, "minlen": 3}\n' +
    'Syntax: run builtin-textanalytics.sentiment {"text": "response", "doc": "group"}\n' +
    'Syntax: run builtin-textanalytics.tfidf {"text": "response", "doc": "group", "topn": 5}\n' +
    'Syntax: run builtin-textanalytics.kwic {"text": "response", "term": "text", "window": 6}\n' +
    '  • text — the free-text column to analyse.\n' +
    '  • other actions: Word cloud, Topic modeling (LDA), Content-analysis dictionary — run builtin-textanalytics.wordCloud / topicModel / dictionary {…}.',
  rPackages: ['tidytext', 'dplyr', 'tibble', 'svglite', 'topicmodels', 'reshape2'],
  menu: [
    {
      label: 'Word frequency…',
      run: 'wordFrequency',
      order: 10,
      inputs: [
        { name: 'text', kind: 'variables', label: 'Text column', hint: 'The free-text responses you want to count words in.', multiple: false, types: ['string'] },
        { name: 'stopwords', kind: 'choice', label: 'Stop words', hint: 'Whether to drop common filler words like the and and.', default: 'remove', options: [
          { value: 'remove', label: 'Remove common stop words (the, and, of…)' },
          { value: 'keep', label: 'Keep all words' },
        ] },
        { name: 'topn', kind: 'number', label: 'How many top words', hint: 'How many of the most frequent words to show.', default: 25 },
        { name: 'minlen', kind: 'number', label: 'Minimum word length', hint: 'Ignore words shorter than this many letters.', default: 3 },
      ],
    },
    {
      label: 'Word cloud…',
      run: 'wordCloud',
      order: 15,
      inputs: [
        { name: 'text', kind: 'variables', label: 'Text column', hint: 'The free-text responses to visualise as a word cloud.', multiple: false, types: ['string'], unique: true },
        { name: 'topn', kind: 'number', label: 'How many words', hint: 'How many of the most frequent words to show.', default: 60 },
        { name: 'minlen', kind: 'number', label: 'Minimum word length', hint: 'Ignore words shorter than this many letters.', default: 3 },
        { name: 'stopwords', kind: 'choice', label: 'Stop words', hint: 'Whether to drop common filler words like the and and.', default: 'remove', options: [
          { value: 'remove', label: 'Remove common stop words (the, and, of…)' },
          { value: 'keep', label: 'Keep all words' },
        ] },
        { name: 'layout', kind: 'choice', label: 'Placement', hint: 'How words are positioned.', default: 'context', options: [
          { value: 'context', label: 'Group related words together (by co-occurrence)' },
          { value: 'spiral', label: 'Pack by frequency (classic spiral)' },
        ] },
        { name: 'themes', kind: 'number', label: 'Colour groups (themes)', hint: 'How many co-occurrence clusters to colour the words by.', default: 5 },
        { name: 'palette', kind: 'choice', label: 'Colours', hint: 'Which palette to colour the themes with.', default: 'cbsafe', options: [
          { value: 'cbsafe', label: 'Colourblind-safe (Okabe–Ito)' },
          { value: 'vivid', label: 'Vivid' },
        ] },
      ],
    },
    {
      label: 'Sentiment analysis…',
      run: 'sentiment',
      order: 20,
      inputs: [
        { name: 'text', kind: 'variables', label: 'Text column', hint: 'The free-text responses to score for positive and negative tone.', multiple: false, types: ['string'], unique: true },
        { name: 'doc', kind: 'variables', label: 'Group / document (optional)', hint: 'Splits responses into groups to compare sentiment across.', multiple: false, types: ['factor', 'string'], optional: true, unique: true },
      ],
    },
    {
      label: 'TF-IDF (distinctive terms)…',
      run: 'tfidf',
      order: 30,
      inputs: [
        { name: 'text', kind: 'variables', label: 'Text column', hint: 'The free-text responses to mine for distinctive terms.', multiple: false, types: ['string'], unique: true },
        { name: 'doc', kind: 'variables', label: 'Group / document', hint: 'Splits responses into groups whose distinctive terms are compared.', multiple: false, types: ['factor', 'string'], unique: true },
        { name: 'topn', kind: 'number', label: 'Top terms per group', hint: 'How many distinctive terms to list for each group.', default: 5 },
      ],
    },
    {
      label: 'Keyword in context (KWIC)…',
      run: 'kwic',
      order: 40,
      inputs: [
        { name: 'text', kind: 'variables', label: 'Text column', hint: 'The free-text responses to search for your keyword.', multiple: false, types: ['string'] },
        { name: 'term', kind: 'text', label: 'Search term (single word)', hint: 'The word to find, shown with the words around it.' },
        { name: 'window', kind: 'number', label: 'Context words each side', hint: 'How many surrounding words to show on each side.', default: 6 },
      ],
    },
    {
      label: 'Topic modeling (LDA)…',
      run: 'topicModel',
      order: 50,
      inputs: [
        { name: 'text', kind: 'variables', label: 'Text column', hint: 'The free-text responses to discover recurring themes across.', multiple: false, types: ['string'] },
        { name: 'k', kind: 'number', label: 'Number of topics', hint: 'How many themes to extract; try a few values and compare.', default: 4 },
        { name: 'topn', kind: 'number', label: 'Top terms per topic', hint: 'How many defining words to show for each topic.', default: 8 },
      ],
    },
    {
      label: 'Content-analysis dictionary…',
      run: 'dictionary',
      order: 60,
      inputs: [
        { name: 'text', kind: 'variables', label: 'Text column', hint: 'The free-text responses to score against your categories.', multiple: false, types: ['string'], unique: true },
        { name: 'dict', kind: 'file', label: 'Dictionary (CSV: category,term)', extensions: ['.csv', '.txt'], hint: 'A CSV with category,term rows — each term counts toward its category.' },
        { name: 'doc', kind: 'variables', label: 'Group / document (optional)', hint: 'Splits responses into groups to compare category counts.', multiple: false, types: ['factor', 'string'], optional: true, unique: true },
      ],
    },
  ],
};

const ACCENT = '#2980b9';
const PRELUDE = 'suppressMessages({library(tidytext); library(dplyr); library(tibble)})';

// --- Word frequency ----------------------------------------------------------

export async function wordFrequency(app, { text, stopwords, topn, minlen }) {
  if (!text) {
    await app.results.appendError('Word frequency: choose a text column.');
    return;
  }
  const N = Number.isFinite(topn) ? Math.max(5, Math.floor(topn)) : 25;
  const ML = Number.isFinite(minlen) ? Math.max(1, Math.floor(minlen)) : 3;
  const rCode = `
    ${PRELUDE}
    suppressMessages(library(svglite))
    txt <- as.character(text)
    d <- tibble(.row = seq_along(txt), text = txt)
    toks <- d %>% unnest_tokens(word, text)
    ${stopwords === 'keep' ? '' : 'data("stop_words"); toks <- toks %>% anti_join(stop_words, by = "word")'}
    toks <- toks %>% filter(nchar(word) >= ${ML} & !grepl("^[0-9]+$", word))
    total <- nrow(toks)
    freq <- toks %>% count(word, sort = TRUE)
    nDistinct <- nrow(freq)
    topf <- head(freq, ${N})
    topb <- head(freq, min(20L, ${N}))
    svg <- ""
    if (nrow(topb) > 0) {
      .ct_dev <- svgstring(width = 7, height = 5, pointsize = 11)
      par(mar = c(4.2, 9, 2.2, 1), col.axis = "#555555", col.lab = "#333333", fg = "#cccccc")
      barplot(rev(topb$n), names.arg = rev(topb$word), horiz = TRUE, las = 1,
              col = "${ACCENT}", border = "white", main = "Most frequent words", xlab = "Count")
      dev.off(); svg <- .ct_dev()
    }
    list(words = topf$word, n = topf$n, total = total, nDistinct = nDistinct, svg = svg)`;
  const { result } = await app.webr.run(rCode);
  const r = flat(result);
  const words = r.strs('words'), counts = r.nums('n'), total = r.num('total');
  if (!words.length) {
    await app.results.appendText('No words found after filtering. Try keeping stop words or lowering the minimum word length.');
    return;
  }
  await app.results.appendTable(
    {
      columns: ['Rank', 'Word', 'Count', '% of words'],
      rows: words.map((w, i) => [String(i + 1), w, String(counts[i]), `${((100 * counts[i]) / total).toFixed(2)}%`]),
      rowHeaders: false,
    },
    { caption: `Word Frequency — ${total.toLocaleString()} word tokens, ${r.num('nDistinct').toLocaleString()} distinct` },
  );
  const svg = r.str1('svg');
  if (svg && /<svg[\s>]/i.test(svg)) await app.results.appendPlot(cleanSvg(svg));
}

// --- Word cloud --------------------------------------------------------------

/**
 * A word cloud where **size = frequency** and, by default, **placement reflects
 * co-occurrence**: words that tend to appear in the same response are drawn near
 * each other. R does the modelling — tokenize, count, build a word×word cosine
 * similarity from co-occurrence, then `cmdscale` (classical MDS) to lay the words
 * out in 2D and `hclust`/`cutree` to colour them by emergent co-occurrence cluster
 * ("theme"). This plugin's own JS then does the visual layout: it anchors each
 * word at its MDS position and spirals it just far enough to remove overlaps, so
 * the cloud is *readable* (no half-overlapping words) while still spatially
 * meaningful. "Classic spiral" packs purely by frequency from the centre instead;
 * it's also the automatic fallback when there are too few words to position.
 */
export async function wordCloud(app, { text, topn, minlen, stopwords, layout, themes, palette }) {
  if (!text) {
    await app.results.appendError('Word cloud: choose a text column.');
    return;
  }
  const N = clampInt(topn, 60, 5, 200);
  const ML = clampInt(minlen, 3, 1, 20);
  const K = clampInt(themes, 5, 2, 8);
  const rCode = `
    ${PRELUDE}
    suppressMessages(library(reshape2))
    txt <- as.character(text)
    d <- tibble(.row = seq_along(txt), text = txt)
    toks <- d %>% unnest_tokens(word, text)
    ${stopwords === 'keep' ? '' : 'data("stop_words"); toks <- toks %>% anti_join(stop_words, by = "word")'}
    toks <- toks %>% filter(nchar(word) >= ${ML} & !grepl("^[0-9]+$", word))
    total <- nrow(toks)
    freq <- toks %>% count(word, sort = TRUE)
    nDistinct <- nrow(freq)
    topw <- head(freq$word, ${N})
    ok <- 0L; xs <- numeric(0); ys <- numeric(0); cl <- integer(0)
    words <- head(freq$word, ${N}); fn <- as.integer(head(freq$n, ${N}))
    if (length(topw) >= 3) {
      cc <- toks %>% filter(word %in% topw) %>% count(.row, word)
      M <- reshape2::acast(cc, .row ~ word, value.var = "n", fill = 0)
      if (is.null(dim(M))) M <- matrix(M, nrow = 1, dimnames = list(NULL, names(M)))
      nrm <- sqrt(colSums(M^2))
      S <- t(M) %*% M
      S <- S / outer(nrm, nrm); S[!is.finite(S)] <- 0
      Dd <- 1 - S; diag(Dd) <- 0; Dd[Dd < 0] <- 0
      co <- tryCatch(cmdscale(as.dist(Dd), k = 2), error = function(e) NULL)
      if (!is.null(co) && is.matrix(co) && ncol(co) >= 2 && nrow(co) == ncol(M)) {
        kk <- max(2L, min(${K}L, nrow(co) - 1L))
        cl0 <- tryCatch(cutree(hclust(dist(co), method = "ward.D2"), k = kk),
                        error = function(e) rep(1L, nrow(co)))
        ord <- match(colnames(M), freq$word)
        words <- colnames(M); fn <- as.integer(freq$n[ord])
        xs <- as.numeric(co[, 1]); ys <- as.numeric(co[, 2]); cl <- as.integer(cl0); ok <- 1L
      }
    }
    list(words = words, freq = fn, x = xs, y = ys, cl = cl,
         total = total, nDistinct = nDistinct, ok = ok)`;
  const { result } = await app.webr.run(rCode);
  const r = flat(result);
  const words = r.strs('words');
  const freq = r.nums('freq');
  if (!words.length) {
    await app.results.appendText('No words found after filtering. Try keeping stop words or lowering the minimum word length.');
    return;
  }
  const contextual = layout !== 'spiral' && r.num('ok') === 1;
  const colours = palette === 'vivid' ? PALETTE_VIVID : PALETTE_CBSAFE;
  const data = { words, freq, x: r.nums('x'), y: r.nums('y'), cl: r.nums('cl').map((v) => Math.round(v)) };
  const render = (w, h) => buildCloudSvg(data, w, h, contextual, colours);

  let handle;
  handle = await app.results.appendPlot(render(680, 440), {
    onRedraw: (w, h) => app.results.updatePlot(handle, render(w, h)),
  });

  // An accessible companion table: the cloud can't be read by a screen reader and
  // exact counts are hard to judge from type size, so list the top words too.
  const themed = contextual && data.cl.length === words.length;
  const tableTop = Math.min(words.length, 30);
  await app.results.appendTable(
    {
      columns: themed ? ['Rank', 'Word', 'Count', 'Theme'] : ['Rank', 'Word', 'Count'],
      rows: Array.from({ length: tableTop }, (_, i) =>
        themed ? [String(i + 1), words[i], String(freq[i]), `Theme ${data.cl[i]}`] : [String(i + 1), words[i], String(freq[i])]),
      rowHeaders: false,
    },
    { caption: `Word Cloud — top ${tableTop} of ${r.num('nDistinct').toLocaleString()} distinct words (${r.num('total').toLocaleString()} tokens)` },
  );
  await app.results.appendText(
    contextual
      ? '**Word size = frequency.** Placement comes from multidimensional scaling of word **co-occurrence**, so words that tend to appear in the same responses sit near each other; **colour** marks emergent co-occurrence clusters (themes). Drag the lower-right grip to resize, then click **⟳ Redraw at this size** to re-pack.'
      : '**Word size = frequency**, packed in a spiral from the centre. (Choose *Group related words together* for a co-occurrence layout — used automatically when there are enough words.) Drag the lower-right grip to resize, then click **⟳ Redraw at this size** to re-pack.',
  );
}

// --- Sentiment ---------------------------------------------------------------

export async function sentiment(app, { text, doc }) {
  if (!text) {
    await app.results.appendError('Sentiment: choose a text column.');
    return;
  }
  const hasDoc = !!doc;
  const rCode = `
    ${PRELUDE}
    txt <- as.character(text)
    ${hasDoc ? 'grp <- as.character(doc)' : 'grp <- rep("All", length(txt))'}
    d <- tibble(.row = seq_along(txt), grp = grp, text = txt)
    toks <- d %>% unnest_tokens(word, text)
    bing <- get_sentiments("bing")
    scored <- toks %>% inner_join(bing, by = "word")
    bytype <- scored %>% count(sentiment)
    nPos <- sum(bytype$n[bytype$sentiment == "positive"]); nNeg <- sum(bytype$n[bytype$sentiment == "negative"])
    topPos <- scored %>% filter(sentiment == "positive") %>% count(word, sort = TRUE) %>% head(10)
    topNeg <- scored %>% filter(sentiment == "negative") %>% count(word, sort = TRUE) %>% head(10)
    byGrp <- scored %>% count(grp, sentiment) %>% tidyr::pivot_wider(names_from = sentiment, values_from = n, values_fill = 0)
    if (is.null(byGrp[["positive"]])) byGrp[["positive"]] <- 0
    if (is.null(byGrp[["negative"]])) byGrp[["negative"]] <- 0
    byGrp$net <- byGrp$positive - byGrp$negative
    byGrp <- byGrp %>% arrange(desc(net))
    list(nPos = nPos, nNeg = nNeg,
         posWords = topPos$word, posN = topPos$n, negWords = topNeg$word, negN = topNeg$n,
         grp = byGrp$grp, gPos = byGrp$positive, gNeg = byGrp$negative, gNet = byGrp$net)`;
  let result;
  try {
    ({ result } = await app.webr.run(rCode));
  } catch (e) {
    // tidyr is a tidytext dep but pull it explicitly if the namespace is missing
    await app.webr.installPackages(['tidyr']);
    ({ result } = await app.webr.run(rCode));
  }
  const r = flat(result);
  const nPos = r.num('nPos'), nNeg = r.num('nNeg'), tot = nPos + nNeg;
  if (!tot) {
    await app.results.appendText('No sentiment-bearing words from the Bing lexicon were found in this text.');
    return;
  }
  await app.results.appendTable(
    {
      columns: ['', 'Count', '% of scored words'],
      rows: [
        ['Positive', String(nPos), `${((100 * nPos) / tot).toFixed(1)}%`],
        ['Negative', String(nNeg), `${((100 * nNeg) / tot).toFixed(1)}%`],
        ['Net (positive − negative)', String(nPos - nNeg), ''],
      ],
      rowHeaders: true,
    },
    { caption: `Sentiment (Bing lexicon) — ${tot.toLocaleString()} scored words` },
  );
  const posW = r.strs('posWords'), posN = r.nums('posN'), negW = r.strs('negWords'), negN = r.nums('negN');
  const maxRows = Math.max(posW.length, negW.length);
  await app.results.appendTable(
    {
      columns: ['Top positive', 'n', 'Top negative', 'n'],
      rows: Array.from({ length: maxRows }, (_, i) => [posW[i] ?? '', posW[i] != null ? String(posN[i]) : '', negW[i] ?? '', negW[i] != null ? String(negN[i]) : '']),
      rowHeaders: false,
    },
    { caption: 'Words Driving Sentiment' },
  );
  if (hasDoc) {
    const g = r.strs('grp'), gp = r.nums('gPos'), gn = r.nums('gNeg'), gnet = r.nums('gNet');
    await app.results.appendTable(
      {
        columns: ['Group', 'Positive', 'Negative', 'Net'],
        rows: g.map((gg, i) => [gg, String(gp[i]), String(gn[i]), String(gnet[i])]),
        rowHeaders: true,
      },
      { caption: 'Net Sentiment by Group' },
    );
  }
  await app.results.appendText(
    'Sentiment uses the **Bing** lexicon (a fixed word list of positive/negative terms). It is a coarse signal — it ignores negation ("not good"), sarcasm and context — so treat it as a starting point for closer reading, not a verdict.',
  );
}

// --- TF-IDF ------------------------------------------------------------------

export async function tfidf(app, { text, doc, topn }) {
  if (!text || !doc) {
    await app.results.appendError('TF-IDF: choose a text column and a group/document variable.');
    return;
  }
  const N = Number.isFinite(topn) ? Math.max(1, Math.floor(topn)) : 5;
  const rCode = `
    ${PRELUDE}
    txt <- as.character(text); grp <- as.character(doc)
    d <- tibble(grp = grp, text = txt)
    counts <- d %>% unnest_tokens(word, text) %>% count(grp, word)
    ti <- counts %>% bind_tf_idf(word, grp, n) %>% arrange(grp, desc(tf_idf))
    top <- ti %>% group_by(grp) %>% slice_head(n = ${N}) %>% ungroup()
    list(grp = as.character(top$grp), word = top$word, n = top$n, tf = top$tf, idf = top$idf, tfidf = top$tf_idf)`;
  const { result } = await app.webr.run(rCode);
  const r = flat(result);
  const g = r.strs('grp'), w = r.strs('word'), n = r.nums('n'), tfidfv = r.nums('tfidf');
  if (!w.length) {
    await app.results.appendText('No terms found for TF-IDF.');
    return;
  }
  await app.results.appendTable(
    {
      columns: ['Group', 'Term', 'Count', 'TF-IDF'],
      rows: g.map((gg, i) => [gg, w[i], String(n[i]), tfidfv[i].toFixed(4)]),
      rowHeaders: false,
    },
    { caption: `Distinctive Terms by Group (top ${N} per group, by TF-IDF)` },
  );
  await app.results.appendText(
    '**TF-IDF** highlights words that are frequent in one group but rare across the others — the terms that *characterise* each group. Words common to every group (and thus uninformative) score near zero and drop out automatically.',
  );
}

// --- Keyword in context (KWIC) ----------------------------------------------

export async function kwic(app, { text, term, window }) {
  if (!text || !term || !String(term).trim()) {
    await app.results.appendError('KWIC: choose a text column and enter a search term.');
    return;
  }
  const W = Number.isFinite(window) ? Math.max(1, Math.floor(window)) : 6;
  const rCode = `
    txt <- as.character(text)
    term <- tolower(trimws(${rStr(String(term))})); win <- ${W}
    rows <- integer(0); lefts <- character(0); kw <- character(0); rights <- character(0)
    for (i in seq_along(txt)) {
      if (is.na(txt[i])) next
      words <- strsplit(tolower(txt[i]), "\\\\W+")[[1]]; words <- words[words != ""]
      hits <- which(words == term)
      for (h in hits) {
        l <- if (h > 1) paste(words[max(1, h - win):(h - 1)], collapse = " ") else ""
        rr <- if (h < length(words)) paste(words[(h + 1):min(length(words), h + win)], collapse = " ") else ""
        rows <- c(rows, i); lefts <- c(lefts, l); kw <- c(kw, words[h]); rights <- c(rights, rr)
      }
    }
    list(row = rows, left = lefts, kw = kw, right = rights, nHits = length(rows), nDocs = length(unique(rows)))`;
  const { result } = await app.webr.run(rCode);
  const r = flat(result);
  const rows = r.nums('row'), left = r.strs('left'), kw = r.strs('kw'), right = r.strs('right');
  if (!rows.length) {
    await app.results.appendText(`No occurrences of "**${term}**" were found in this text.`);
    return;
  }
  await app.results.appendTable(
    {
      columns: ['Row', 'Left context', 'Keyword', 'Right context'],
      rows: rows.map((rw, i) => [String(rw), `…${left[i]}`, kw[i], `${right[i]}…`]),
      rowHeaders: false,
    },
    { caption: `Keyword in Context — "${term}" (${r.num('nHits')} occurrences in ${r.num('nDocs')} rows)` },
  );
}

// --- Topic modeling (LDA) ----------------------------------------------------

export async function topicModel(app, { text, k, topn }) {
  if (!text) {
    await app.results.appendError('Topic modeling: choose a text column.');
    return;
  }
  const K = Number.isFinite(k) ? Math.max(2, Math.floor(k)) : 4;
  const N = Number.isFinite(topn) ? Math.max(3, Math.floor(topn)) : 8;
  const rCode = `
    ${PRELUDE}
    suppressMessages(library(topicmodels))
    txt <- as.character(text)
    d <- tibble(doc = seq_along(txt), text = txt)
    data("stop_words")
    toks <- d %>% unnest_tokens(word, text) %>% anti_join(stop_words, by = "word") %>%
      filter(nchar(word) >= 3 & !grepl("^[0-9]+$", word))
    counts <- toks %>% count(doc, word)
    nDocs <- length(unique(counts$doc)); nTerms <- length(unique(counts$word))
    if (nDocs < ${K} || nTerms < ${K}) {
      list(err = sprintf("Need at least %d documents and %d distinct terms for %d topics (have %d docs, %d terms).", ${K}, ${K}, ${K}, nDocs, nTerms))
    } else {
      dtm <- counts %>% cast_dtm(doc, word, n)
      lda <- LDA(dtm, k = ${K}, control = list(seed = 1234))
      beta <- tidy(lda, matrix = "beta")
      top <- beta %>% group_by(topic) %>% slice_max(beta, n = ${N}, with_ties = FALSE) %>% ungroup() %>% arrange(topic, desc(beta))
      gamma <- tidy(lda, matrix = "gamma")
      dom <- gamma %>% group_by(document) %>% slice_max(gamma, n = 1, with_ties = FALSE) %>% ungroup()
      domCount <- dom %>% count(topic) %>% arrange(topic)
      list(topic = top$topic, term = top$term, beta = top$beta,
           domTopic = domCount$topic, domN = domCount$n, nDocs = nDocs, nTerms = nTerms, err = "")
    }`;
  let result;
  try {
    ({ result } = await app.webr.run(rCode));
  } catch (e) {
    if (/tidyr/.test(String(e))) {
      await app.webr.installPackages(['tidyr']);
      ({ result } = await app.webr.run(rCode));
    } else throw e;
  }
  const r = flat(result);
  const err = r.str1('err');
  if (err) {
    await app.results.appendText(err);
    return;
  }
  const topic = r.nums('topic'), term = r.strs('term');
  const byTopic = new Map();
  topic.forEach((t, i) => {
    if (!byTopic.has(t)) byTopic.set(t, []);
    byTopic.get(t).push(term[i]);
  });
  const rows = [...byTopic.entries()].sort((a, b) => a[0] - b[0]).map(([t, terms]) => [`Topic ${t}`, terms.join(', ')]);
  await app.results.appendTable(
    { columns: ['Topic', `Top ${N} terms`], rows, rowHeaders: true },
    { caption: `Topic Modeling (LDA, k=${K}) — ${r.num('nDocs')} documents, ${r.num('nTerms')} terms` },
  );
  const dt = r.nums('domTopic'), dn = r.nums('domN');
  if (dt.length) {
    await app.results.appendTable(
      { columns: ['Topic', 'Documents where dominant'], rows: dt.map((t, i) => [`Topic ${t}`, String(dn[i])]), rowHeaders: true },
      { caption: 'Dominant Topic per Document' },
    );
  }
  await app.results.appendText(
    '**Topic modeling (LDA)** groups co-occurring words into latent themes — each topic is a weighted word list you read and name. There is no single "right" number of topics; try a few values of *k* and compare which gives the most interpretable themes.',
  );
}

// --- Content-analysis dictionary --------------------------------------------

export async function dictionary(app, { text, dict, doc }) {
  if (!text) {
    await app.results.appendError('Content analysis: choose a text column.');
    return;
  }
  if (!dict || !dict.bytes) {
    await app.results.appendError('Content analysis: choose a dictionary CSV (category,term rows).');
    return;
  }
  const pairs = parseDict(new TextDecoder().decode(dict.bytes));
  if (!pairs.length) {
    await app.results.appendError('That dictionary file had no usable "category,term" rows.');
    return;
  }
  const cats = pairs.map((p) => p[0]);
  const terms = pairs.map((p) => p[1]);
  const hasDoc = !!doc;
  const rCode = `
    ${PRELUDE}
    txt <- as.character(text)
    ${hasDoc ? 'grp <- as.character(doc)' : 'grp <- rep("All", length(txt))'}
    dict <- tibble(category = c(${cats.map(rStr).join(', ')}), word = tolower(c(${terms.map(rStr).join(', ')})))
    d <- tibble(.row = seq_along(txt), grp = grp, text = txt)
    toks <- d %>% unnest_tokens(word, text)
    nWords <- nrow(toks)
    hits <- toks %>% inner_join(dict, by = "word")
    byCat <- hits %>% count(category) %>% arrange(desc(n))
    byGrpCat <- hits %>% count(grp, category) %>% arrange(grp, desc(n))
    list(cat = byCat$category, n = byCat$n, nWords = nWords, nCats = length(unique(dict$category)),
         g = as.character(byGrpCat$grp), gc = byGrpCat$category, gn = byGrpCat$n)`;
  const { result } = await app.webr.run(rCode);
  const r = flat(result);
  const cat = r.strs('cat'), n = r.nums('n'), nWords = r.num('nWords');
  if (!cat.length) {
    await app.results.appendText('No dictionary terms matched the text. Check that the dictionary words match the language/spelling in the responses.');
    return;
  }
  await app.results.appendTable(
    { columns: ['Category', 'Matches', '% of words'], rows: cat.map((c, i) => [c, String(n[i]), `${((100 * n[i]) / nWords).toFixed(2)}%`]), rowHeaders: true },
    { caption: `Content Analysis — ${nWords.toLocaleString()} words scored against ${r.num('nCats')} categories` },
  );
  if (hasDoc) {
    const g = r.strs('g'), gc = r.strs('gc'), gn = r.nums('gn');
    if (g.length) {
      await app.results.appendTable(
        { columns: ['Group', 'Category', 'Matches'], rows: g.map((gg, i) => [gg, gc[i], String(gn[i])]), rowHeaders: false },
        { caption: 'Category Counts by Group' },
      );
    }
  }
  await app.results.appendText(
    '**Dictionary content analysis** counts how often words from each of your categories appear — the classic mixed-methods bridge from qualitative codes to quantitative counts. Build the categories around your codebook; only exact word matches are counted (no stemming).',
  );
}

/** Parse a dictionary CSV into [category, term] pairs (term lower-cased). Accepts
 * an optional `category,term`/`category,word` header; tolerates quotes. */
function parseDict(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
    if (cells.length < 2) continue;
    const [a, b] = cells;
    if (i === 0 && /^categ/i.test(a) && /^(term|word)/i.test(b)) continue; // header row
    if (!a || !b) continue;
    out.push([a, b.toLowerCase()]);
  }
  return out;
}

// --- helpers -----------------------------------------------------------------

/** Default theme palette: the **Okabe–Ito** qualitative set — designed to stay
 * distinguishable under the common forms of colour-vision deficiency (no relying
 * on a red/green contrast). Okabe–Ito's pale yellow is dropped (too low-contrast
 * as text on white) and a neutral grey added, keeping eight legible hues. */
const PALETTE_CBSAFE = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#000000', '#666666', '#56B4E9'];

/** Alternative brighter palette (the user can opt into it); NOT colourblind-safe
 * — it pairs a red and a green that some viewers can't tell apart. */
const PALETTE_VIVID = ['#2980b9', '#27ae60', '#c0392b', '#8e44ad', '#d35400', '#16a085', '#2c3e50', '#c2185b'];

/** Clamp an optional numeric input to an integer in [lo, hi], defaulting if unset. */
function clampInt(v, dflt, lo, hi) {
  const x = Number.isFinite(v) ? Math.floor(v) : dflt;
  return Math.max(lo, Math.min(hi, x));
}

/** XML-escape text for safe inclusion in the SVG (also re-sanitised host-side). */
function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Single-hue colour for the no-theme (spiral / too-few-words) case: darker = more
 * frequent, so the visual still encodes frequency beyond size alone. */
function freqColour(f, fmin, fmax) {
  const t = fmax > fmin ? (f - fmin) / (fmax - fmin) : 0.5;
  return `hsl(207, 60%, ${Math.round(62 - t * 42)}%)`;
}

/**
 * Build the word-cloud SVG. Words are sized by frequency and placed by spiralling
 * out from a target until they no longer overlap any already-placed word — so the
 * cloud is always readable. The target is the word's MDS position (contextual
 * layout) or the canvas centre (spiral layout). Layout is deterministic (no RNG),
 * so a redraw at the same size is stable.
 *
 * @param {{words:string[], freq:number[], x:number[], y:number[], cl:number[]}} data
 * @param {number} W - target canvas width (px)
 * @param {number} H - target canvas height (px)
 * @param {boolean} contextual - true → anchor at MDS coords; false → spiral from centre
 * @param {string[]} palette - theme colours (cycled if there are more themes)
 * @returns {string} an `<svg>` fragment
 */
function buildCloudSvg(data, W, H, contextual, palette = PALETTE_CBSAFE) {
  const { words, freq, x, y, cl } = data;
  const n = words.length;
  if (!n) return '';
  const W2 = Math.max(320, Math.round(W));
  const H2 = Math.max(220, Math.round(H));
  const MINPX = Math.max(10, Math.round(H2 * 0.028));
  const MAXPX = Math.max(MINPX + 8, Math.round(H2 * 0.13));
  const fmin = Math.min(...freq);
  const fmax = Math.max(...freq);
  const sq = (v) => Math.sqrt(Math.max(0, v));
  const sizeOf = (f) => {
    const t = fmax > fmin ? (sq(f) - sq(fmin)) / (sq(fmax) - sq(fmin)) : 0.5;
    return Math.round(MINPX + t * (MAXPX - MINPX));
  };

  // Biggest words first, so the prominent terms claim their target spot.
  const order = [...Array(n).keys()].sort((a, b) => freq[b] - freq[a]);

  const margin = Math.round(MAXPX * 0.6);
  const cx0 = W2 / 2;
  const cy0 = H2 / 2;
  const tx = new Array(n);
  const ty = new Array(n);
  const useCoords = contextual && x.length === n && y.length === n;
  if (useCoords) {
    const xmin = Math.min(...x), xmax = Math.max(...x), ymin = Math.min(...y), ymax = Math.max(...y);
    const sx = xmax > xmin ? (W2 - 2 * margin) / (xmax - xmin) : 0;
    const sy = ymax > ymin ? (H2 - 2 * margin) / (ymax - ymin) : 0;
    for (let i = 0; i < n; i++) {
      tx[i] = xmax > xmin ? margin + (x[i] - xmin) * sx : cx0;
      ty[i] = ymax > ymin ? margin + (y[i] - ymin) * sy : cy0;
    }
  } else {
    for (let i = 0; i < n; i++) { tx[i] = cx0; ty[i] = cy0; }
  }

  const placed = []; // axis-aligned bounding boxes already taken
  const overlaps = (b) => placed.some((p) => !(b.x1 < p.x0 || b.x0 > p.x1 || b.y1 < p.y0 || b.y0 > p.y1));
  const themed = cl && cl.length === n;
  const out = [];
  for (const i of order) {
    const fs = sizeOf(freq[i]);
    const halfW = words[i].length * fs * 0.30 + 3; // ~0.6·fs per char (system-ui)
    const halfH = fs * 0.62;
    const step = Math.max(2, fs * 0.22);
    let fx = tx[i], fy = ty[i], found = false;
    for (let s = 0; s < 1600; s++) {
      const ang = 0.5 * s;
      const rad = step * 0.2 * ang;
      const px = tx[i] + rad * Math.cos(ang);
      const py = ty[i] + rad * Math.sin(ang);
      const box = { x0: px - halfW, x1: px + halfW, y0: py - halfH, y1: py + halfH };
      if (box.x0 < 4 || box.x1 > W2 - 4 || box.y0 < 4 || box.y1 > H2 - 4) continue;
      if (!overlaps(box)) { fx = px; fy = py; placed.push(box); found = true; break; }
    }
    if (!found) {
      fx = Math.min(W2 - halfW - 4, Math.max(halfW + 4, tx[i]));
      fy = Math.min(H2 - halfH - 4, Math.max(halfH + 4, ty[i]));
      placed.push({ x0: fx - halfW, x1: fx + halfW, y0: fy - halfH, y1: fy + halfH });
    }
    const colour = themed
      ? palette[(((cl[i] - 1) % palette.length) + palette.length) % palette.length]
      : freqColour(freq[i], fmin, fmax);
    const weight = fs >= (MINPX + MAXPX) / 2 ? 600 : 400;
    out.push(
      `<text x="${fx.toFixed(1)}" y="${fy.toFixed(1)}" font-size="${fs}" fill="${colour}" ` +
        `text-anchor="middle" dominant-baseline="central" ` +
        `font-family="system-ui, -apple-system, Segoe UI, sans-serif" style="font-weight:${weight}">` +
        `<title>${escapeXml(words[i])} (${freq[i]})</title>${escapeXml(words[i])}</text>`,
    );
  }
  return (
    `<svg viewBox="0 0 ${W2} ${H2}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Word cloud">` +
    `<rect x="0" y="0" width="${W2}" height="${H2}" fill="#ffffff"/>` +
    out.join('') +
    `</svg>`
  );
}

function cleanSvg(svg) {
  return String(svg)
    .replace(/(<svg\b[^>]*?)\s+width='[^']*'/i, '$1')
    .replace(/(<svg\b[^>]*?)\s+height='[^']*'/i, '$1');
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function flat(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList || {});
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    nums: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    strs: (k) => arr(byName[k]).map(String),
    num: (k) => {
      const a = arr(byName[k]);
      return a.length ? Number(a[0]) : NaN;
    },
    str1: (k) => {
      const a = arr(byName[k]);
      return a.length ? String(a[0]) : '';
    },
  };
}
