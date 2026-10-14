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
 * Kept to what core actually owns — importing, the data grid, weighting, history,
 * projects — because a topic claiming to teach an analysis would be documenting a plugin
 * from outside it, which is the coupling this design exists to avoid.
 */
export const CORE_HOWTO = {
  id: 'crosstab',
  name: 'CrossTab',
  enabled: true,
  howtoFile: FILE,
  howtoIndex: [
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
  ],
};
