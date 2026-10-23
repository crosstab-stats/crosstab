/**
 * @file howto-core.js
 * The host's own how-to declaration (#192).
 *
 * This is a catalogue row of exactly the shape a plugin's is, with `howtoIndex` and
 * `howtoFile` meaning precisely what they mean in a manifest. The host needs it written
 * here rather than read from a manifest for one boring reason — it has no manifest file —
 * and that is the *only* way core is special. Ordering, search, resolution, link handling
 * and rendering all treat this row as one entry among the rest.
 *
 * If a topic here ever needs something a plugin's topic cannot have, that is a bug in the
 * mechanism, not a feature of being the host.
 */

/** Where the host's sidecar lives, relative to the app. */
const FILE = 'docs/howto-core.md';

/**
 * The host's topics: the things that are nobody's plugin.
 *
 * Two layers, and the distinction is load-bearing.
 *
 * **Procedure pages** are kept to what core actually owns — importing, the data grid,
 * weighting, history, projects — because a topic claiming to teach an analysis would be
 * documenting a plugin from outside it, which is the coupling this design exists to
 * avoid.
 *
 * **Task pages** (`How do I…`, #184) are the layer above: the questions that span several
 * plugins, which is exactly why they are not any one plugin's. They route and they do not
 * restate — a task page that explained how to run a crosstab would be a second copy of
 * `crosstabs-basics`, free to drift, while the plugin's own page is the one maintained
 * alongside the dialog. Core is not privileged in holding them; it is simply the only
 * participant that spans everything.
 */
export const CORE_HOWTO = {
  id: 'crosstab',
  name: 'CrossTab',
  enabled: true,
  howtoFile: FILE,
  howtoIndex: [
    // ---------------------------------------------------------------------------------
    // The TASK layer (#184). Everything below the next divider is a PROCEDURE page,
    // owned by whoever owns the procedure. These are the questions that span several of
    // them, which is why they are core's: no single plugin owns "which test do I use".
    //
    // Each one routes onward and restates nothing. A task page that explained how to run
    // a crosstab would be a second copy of `crosstabs-basics`, free to drift from it, and
    // the plugin's own page is the one that gets updated when the dialog changes.
    //
    // Listed FIRST because `pluginPage` reads declaration order, and because the reader
    // who needs this layer most is the one who does not yet know what to search for.
    // ---------------------------------------------------------------------------------
    {
      id: 'task-choose-a-test',
      title: 'How do I choose a test?',
      category: 'How do I…',
      keywords: ['which test', 'choose', 'what test should i use', 'pick a test', 'decide',
        'significance', 'hypothesis', 'nominal', 'ordinal', 'scale', 'measure', 'help'],
      seeAlso: ['task-compare-groups', 'task-two-categorical', 'task-two-numeric',
        'task-predict-an-outcome', 'plots-choosing'],
    },
    {
      id: 'task-prepare-data',
      title: 'How do I get my data ready to analyse?',
      category: 'How do I…',
      keywords: ['prepare', 'clean', 'ready', 'labels', 'missing', 'types', 'first steps',
        'before analysis', 'tidy', 'setup'],
      seeAlso: ['import-data', 'variable-types', 'recode-a-variable', 'select-cases'],
    },
    {
      id: 'task-describe-one-variable',
      title: 'How do I describe one variable?',
      category: 'How do I…',
      keywords: ['describe', 'one variable', 'univariate', 'summary', 'mean', 'median',
        'mode', 'frequency', 'distribution', 'spread', 'variance', 'range'],
      seeAlso: ['frequencies-basics', 'descriptives-basics', 'frequencies-statistics',
        'descriptives-explore', 'plots-histogram'],
    },
    {
      id: 'task-two-categorical',
      title: 'How do I report a relationship between two categorical variables?',
      category: 'How do I…',
      keywords: ['crosstab', 'cross tabulation', 'contingency', 'chi square', 'chi-square',
        'two categorical', 'nominal', 'percentages', 'association', 'odds ratio'],
      seeAlso: ['crosstabs-basics', 'crosstabs-percentages', 'crosstabs-measures',
        'epi-measures', 'task-choose-a-test'],
    },
    {
      id: 'task-compare-groups',
      title: 'How do I compare a mean across groups?',
      category: 'How do I…',
      keywords: ['compare', 'groups', 'means', 't test', 't-test', 'anova', 'difference',
        'two groups', 'three groups', 'levene', 'equal variances'],
      seeAlso: ['compare-independent', 'compare-oneway', 'compare-paired',
        'assumptions-levene', 'task-choose-a-test'],
    },
    {
      id: 'task-two-numeric',
      title: 'How do I see whether two numeric variables move together?',
      category: 'How do I…',
      keywords: ['correlation', 'correlate', 'scatter', 'relationship', 'two numeric',
        'pearson', 'spearman', 'r', 'association', 'linear'],
      seeAlso: ['correlation-bivariate', 'plots-scatter', 'correlation-partial',
        'regression-linear', 'task-choose-a-test'],
    },
    {
      id: 'task-predict-an-outcome',
      title: 'How do I predict an outcome from several variables?',
      category: 'How do I…',
      keywords: ['regression', 'predict', 'model', 'several predictors', 'multivariate',
        'control for', 'adjust', 'logistic', 'count', 'ordinal'],
      seeAlso: ['regression-linear', 'logistic-binary', 'logistic-categorical',
        'count-poisson', 'ordinal-ordinal'],
    },
    {
      id: 'task-weighted-analysis',
      title: 'How do I use my survey’s weight?',
      category: 'How do I…',
      keywords: ['weight', 'weighted', 'survey', 'sampling weight', 'wtssall', 'design',
        'representative', 'population', 'gss'],
      seeAlso: ['weight-cases', 'frequencies-weighted', 'survey-means', 'survey-crosstab',
        'survey-regression'],
    },
    {
      id: 'task-build-a-scale',
      title: 'How do I build an index or scale score?',
      category: 'How do I…',
      keywords: ['index', 'scale', 'score', 'composite', 'sum', 'count values', 'alpha',
        'reliability', 'cronbach', 'combine variables'],
      seeAlso: ['compute-a-variable', 'reliability-alpha', 'recode-a-variable',
        'task-describe-one-variable'],
    },
    {
      id: 'task-write-up',
      title: 'How do I write up exactly what I did?',
      category: 'How do I…',
      keywords: ['write up', 'report', 'methods', 'reproduce', 'replicate', 'what did i do',
        'syntax', 'do file', 'audit', 'share', 'hand in', 'assignment'],
      seeAlso: ['history-and-undo', 'syntax-basics', 'syntax-save-load', 'export-data'],
    },
    // ---------------------------------------------------------------------------------
    // Procedure pages for the things core itself owns.
    // ---------------------------------------------------------------------------------
    {
      id: 'import-data',
      title: 'Open a data file',
      category: 'Getting started',
      keywords: ['import', 'open', 'load', 'spss', 'sav', 'stata', 'dta', 'csv', 'excel', 'xlsx', 'parquet', 'file'],
      seeAlso: ['variable-types', 'export-data'],
    },
    {
      id: 'variable-types',
      title: 'Set a variable’s type, labels and missing values',
      category: 'Getting started',
      keywords: ['variable', 'view', 'type', 'measure', 'nominal', 'ordinal', 'scale', 'label', 'value labels', 'missing', 'metadata'],
      seeAlso: ['recode-a-variable'],
    },
    {
      id: 'compute-a-variable',
      title: 'Compute a new variable',
      category: 'Working with data',
      keywords: ['compute', 'calculate', 'expression', 'formula', 'sql', 'derive', 'new variable'],
      seeAlso: ['recode-a-variable', 'select-cases'],
    },
    {
      id: 'recode-a-variable',
      title: 'Recode a variable into groups',
      category: 'Working with data',
      keywords: ['recode', 'group', 'band', 'categorise', 'categorize', 'bucket', 'collapse', 'age groups'],
      seeAlso: ['compute-a-variable', 'variable-types'],
    },
    {
      id: 'select-cases',
      title: 'Use only some of the rows',
      category: 'Working with data',
      keywords: ['select', 'filter', 'subset', 'keep if', 'exclude', 'cases', 'rows'],
      seeAlso: ['compute-a-variable'],
    },
    {
      id: 'weight-cases',
      title: 'Weight the cases',
      category: 'Working with data',
      keywords: ['weight', 'weighting', 'survey', 'design weight', 'frequency weight', 'wtssps'],
      seeAlso: ['select-cases'],
    },
    {
      id: 'history-and-undo',
      title: 'Go back, reorder, and see what you did',
      category: 'Working with data',
      keywords: ['history', 'undo', 'redo', 'rewind', 'steps', 'reorder', 'timeline', 'audit', 'reproduce'],
      seeAlso: ['syntax-basics'],
    },
    {
      id: 'syntax-basics',
      title: 'Read and run the script',
      category: 'Working with data',
      keywords: ['syntax', 'script', 'command', 'do file', 'batch', 'reproducible', 'run'],
      seeAlso: ['history-and-undo'],
    },
    {
      id: 'find-an-analysis',
      title: 'Find the analysis you want',
      category: 'Getting started',
      keywords: ['analysis', 'analyse', 'analyze', 'plugin', 'enable', 'menu', 'missing', 'where is'],
      seeAlso: ['import-data'],
    },
    {
      id: 'export-data',
      title: 'Save your work and export results',
      category: 'Getting started',
      keywords: ['save', 'export', 'output', 'report', 'csv', 'html', 'project', 'share'],
      seeAlso: ['import-data'],
    },
    // The command reference, moved out of the Syntax guide dialog (#192). Here rather
    // than there so each command is a SEARCHABLE row in the one index: "how do I recode"
    // now finds the `recode` command beside the GUI topic, which a separate dialog could
    // never do. Ids are written by hand because they are permanent addresses that a
    // plugin author may link to; the prose is the reviewed original, carried over.
    {
      id: 'syntax-compute',
      title: 'compute — make a variable from an expression',
      category: 'Syntax',
      keywords: ['compute', 'name', 'expr', 'calculate', 'formula', 'derive', 'new variable', 'sql'],
      seeAlso: ['syntax-basics'],
    },
    {
      id: 'syntax-recode',
      title: 'recode — map values into a new variable',
      category: 'Syntax',
      keywords: ['recode', 'src', 'into', 'name', 'rules', 'group', 'band', 'categorise', 'categorize', 'collapse'],
      seeAlso: ['syntax-basics'],
    },
    {
      id: 'syntax-keep-if',
      title: 'keep if — filter which rows are used',
      category: 'Syntax',
      keywords: ['keep', 'expr', 'filter', 'subset', 'select cases', 'rows', 'condition'],
      seeAlso: ['syntax-basics'],
    },
    {
      id: 'syntax-drop',
      title: 'drop — remove columns',
      category: 'Syntax',
      keywords: ['drop', 'remove', 'columns', 'variables', 'delete column'],
      seeAlso: ['syntax-basics'],
    },
    {
      id: 'syntax-keep-vars',
      title: 'keep — keep only these columns',
      category: 'Syntax',
      keywords: ['keep', 'columns', 'variables', 'subset', 'retain'],
      seeAlso: ['syntax-basics'],
    },
    {
      id: 'syntax-rename',
      title: 'rename — change a variable name',
      category: 'Syntax',
      keywords: ['rename', 'old', 'new', 'name', 'variable'],
      seeAlso: ['syntax-basics'],
    },
    {
      id: 'syntax-set-cell',
      title: 'set cell — edit one value',
      category: 'Syntax',
      keywords: ['set', 'cell', 'row', 'column', 'value', 'edit', 'correct', 'fix'],
      seeAlso: ['syntax-basics'],
    },
    {
      id: 'syntax-label-variable',
      title: 'label variable — give a variable a readable name',
      category: 'Syntax',
      keywords: ['label', 'variable', 'name', 'description', 'title'],
      seeAlso: ['syntax-basics'],
    },
    {
      id: 'syntax-label-values',
      title: 'label values — name the codes',
      category: 'Syntax',
      keywords: ['label', 'values', 'name', 'code', 'value labels', 'codes', 'categories'],
      seeAlso: ['syntax-basics'],
    },
    {
      id: 'syntax-set-type',
      title: 'set type — change how values are stored',
      category: 'Syntax',
      keywords: ['set', 'type', 'name', 'numeric', 'string', 'factor', 'storage'],
      seeAlso: ['syntax-basics'],
    },
    {
      id: 'syntax-set-measure',
      title: 'set measure — nominal, ordinal or scale',
      category: 'Syntax',
      keywords: ['set', 'measure', 'name', 'nominal', 'ordinal', 'scale', 'measurement', 'level'],
      seeAlso: ['syntax-basics'],
    },
    {
      id: 'syntax-set-missing',
      title: 'set missing — declare user-missing codes',
      category: 'Syntax',
      keywords: ['set', 'missing', 'name', 'user missing', 'codes', 'na'],
      seeAlso: ['syntax-basics'],
    },
    {
      id: 'syntax-run',
      title: 'run — call an analysis from the script',
      category: 'Syntax',
      keywords: ['run', 'analysis', 'plugin', 'call', 'json', 'inputs'],
      seeAlso: ['syntax-basics'],
    },
    {
      id: 'syntax-comment',
      title: '# — comments and data anchors',
      category: 'Syntax',
      keywords: ['comment', 'note', 'source', 'anchor'],
      seeAlso: ['syntax-basics'],
    },
    {
      id: 'syntax-expressions',
      title: 'Expressions, names and quoting',
      category: 'Syntax',
      keywords: ['expression', 'sql', 'duckdb', 'quoting', 'backtick', 'string', 'number', 'name', 'spaces'],
      seeAlso: ['syntax-basics'],
    },
    // In the Syntax category on purpose (#176's loose end). The guide documented the
    // grammar and every command and said nothing about the script being a FILE you can
    // send someone — so a reader who opened it to answer "how do I give this to my Stata
    // colleague" found fifteen commands and no mention that the button exists.
    {
      id: 'syntax-save-load',
      title: 'Save the script, or open one — .ctscript, Stata .do, SPSS .sps, R',
      category: 'Syntax',
      keywords: ['export script', 'import script', 'ctscript', 'do file', 'stata', 'sps',
        'spss syntax', 'r script', 'save script', 'share', 'colleague', 'reproduce', 'send'],
      seeAlso: ['syntax-basics', 'history-and-undo', 'export-data'],
    },
  ],
};
