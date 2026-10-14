# builtin-textanalytics — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: text-wordfreq
Counts the words in a free-text column — the first look at open-ended answers.

**Analyze ▸ Text ▸ Word frequency…**, then pick the **text** column and set:

- **stopwords** — `remove` strips "the", "and", "of" and friends;
- **topn** — how many terms to list;
- **minlen** — ignore words shorter than this.

Leave stopwords in and the top of the list is grammar rather than content. Take them out and you see what people actually wrote about.

Frequency alone favours words that are common everywhere. For the words that distinguish one group from another, [TF-IDF](howto:text-tfidf) is the better question.

Syntax:

`run builtin-textanalytics.wordFrequency {"text": "response", "stopwords": "remove", "topn": 25, "minlen": 3}`

--- id: text-wordcloud
[Word frequencies](howto:text-wordfreq) drawn with size standing in for count.

**Analyze ▸ Text ▸ Word cloud…**, then pick the text column.

Good for a first impression and for an audience; poor for comparison, because area is hard to judge and layout is partly decorative. If the point is which words are commonest, the frequency table says it more precisely — use both, and quote the table.

--- id: text-sentiment
Scores each response for polarity — broadly positive or negative.

**Analyze ▸ Text ▸ Sentiment analysis…**, then pick the **text** column and optionally a **doc** column to group by.

Lexicon-based scoring counts words against a list. It therefore misses negation, sarcasm and domain meaning: "not bad" and "sick" are exactly the cases it gets wrong, and a short response gives it very little to work with.

Treat the scores as a rough sort, and read a sample of the extremes to see whether the sorting is sane before reporting anything from it.

Syntax:

`run builtin-textanalytics.sentiment {"text": "response", "doc": "group"}`

--- id: text-tfidf
The words that are characteristic of one group rather than common everywhere.

**Analyze ▸ Text ▸ TF-IDF (distinctive terms)…**, then pick the **text** column, the **doc** column that defines the groups, and **topn**.

This is the right question when comparing: [plain frequency](howto:text-wordfreq) will tell you every group talks about the same ordinary things, while TF-IDF surfaces what each one says that the others do not.

Syntax:

`run builtin-textanalytics.tfidf {"text": "response", "doc": "group", "topn": 5}`

--- id: text-kwic
A concordance: every occurrence of a term with the words around it.

**Analyze ▸ Text ▸ Keyword in context (KWIC)…**, then pick the **text** column, the **term**, and the **window** — how many words of context either side.

This is the check that keeps every other text method honest. A word that looks important in a frequency list often turns out to be used in one stock phrase, or in the opposite sense to what you assumed, and the concordance is where that becomes visible.

Syntax:

`run builtin-textanalytics.kwic {"text": "response", "term": "support", "window": 6}`

--- id: text-topics
Finds groups of words that tend to occur together, offered as "topics".

**Analyze ▸ Text ▸ Topic modeling (LDA)…**, then pick the text column and the number of topics.

Two cautions worth keeping. The number of topics is **your** choice and the model will produce exactly that many whether or not the corpus has them. And a topic is a list of co-occurring words — naming it is interpretation, done by you, and the name can easily claim more coherence than the word list supports.

Read the documents each topic loads on, via [KWIC](howto:text-kwic), before you believe a label.

--- id: text-dictionary
Counts text against **your own** categories: a dictionary of terms per category, applied to each response.

**Analyze ▸ Text ▸ Content-analysis dictionary…**

Where [topic modelling](howto:text-topics) discovers categories from the data, this applies categories you defined in advance — the theory-driven counterpart, and the one that produces results you can defend as measuring what you said you were measuring.

Its weakness is the mirror of its strength: it finds only what your dictionary names. Build it from a reading of the material, not from guesswork, and [check a sample in context](howto:text-kwic).
