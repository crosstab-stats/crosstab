/**
 * @file chart-renderer.js
 * Host-side, data-driven chart renderer — the other half of the plotting model.
 *
 * This file is now the PUBLIC FACE of the chart layer, not its implementation. The
 * runtime lives in ./charts/runtime.js and each chart kind in ./charts/kinds/, one
 * module apiece, each registering itself on import. Everything below is re-exported
 * from here so existing importers are unaffected.
 *
 * The legacy path (`results.appendPlot`) takes a finished SVG baked in R: by the
 * time the host sees it, it's a picture, so colours, ordering, stacking and the
 * legend can't be changed without re-running R. This module instead renders a
 * **structured chart model** to SVG in plain JS, so a chart can be re-ordered,
 * recoloured and re-stacked *instantly* with no WebR round-trip. (The word cloud
 * already proved this R-computes-data / JS-renders-SVG split works here.)
 *
 * ## Extensibility — the chart-kind registry
 * Chart *kinds* (categorical, scatter, pie, …) are entries in a registry, not a
 * hardcoded switch. Each kind is one object declaring how to draw itself, its view
 * defaults, the items that take palette colours, and which controls it offers:
 *
 *   registerChartKind('whatever', {
 *     render(model, view) -> svgString,
 *     baseView(model)     -> Partial<ViewState>,   // kind-specific view defaults
 *     colorItems(model)   -> [{key,label}],         // legend/colour/reorder entries
 *     colorLabel,                                    // 'Series' | 'Slices' | …
 *     reorderCategories,                             // expose an x-axis order list?
 *     controls(model)     -> [ControlDescriptor],   // kind-specific control widgets
 *   })
 *
 * Adding a new chart type tomorrow is "register one object" — the renderer, the
 * controls panel (chart-controls.js, descriptor-driven), persistence and export all
 * pick it up with no further changes. The shared controls (palette, legend, value
 * labels, the colour/reorder lists) are built from helpers any kind can reuse.
 *
 * Pure module: no DOM, no app deps. `renderChart` returns a string. Model text is
 * escaped for SVG; callers still sanitise the result before insertion.
 *
 * @typedef {Object} ChartModel
 * @property {string} kind - a registered chart kind ('categorical' | 'scatter' | 'pie').
 * @property {string} [title]
 * @property {{key:string,label:string}[]} [categories] - x items (categorical), natural order.
 * @property {{key:string,label:string,values:(number|null)[],rawValues?:number[][]}[]} [series] - categorical series; values align to categories. Optional rawValues: per-category arrays of raw observations (enables point overlay + error bars).
 * @property {{x:number,y:number,g?:string}[]} [points] - scatter points (optional group key `g`).
 * @property {{key:string,label:string}[]} [groups] - scatter group legend entries (when points carry `g`).
 * @property {{slope:number,intercept:number,r2:number}} [trend] - scatter regression line.
 * @property {{key:string,label:string,value:number}[]} [slices] - pie slices.
 * @property {{x?:{title?:string},y?:{title?:string}}} [axes]
 * @property {Partial<ViewState>} [view] - plugin-suggested display defaults.
 *
 * @typedef {Object} ViewState
 * @property {'bar'|'line'} [mark] - categorical: bars or lines.
 * @property {'none'|'stacked'|'percent'} [stack] - grouped / stacked / 100%-stacked (bars).
 * @property {string[]} seriesOrder - colour-item keys, in draw/legend order.
 * @property {string[]} categoryOrder - category keys, in axis order.
 * @property {Object<string,string>} colors - per-item colour overrides (key → #hex).
 * @property {string} palette - palette id (see {@link PALETTES}).
 * @property {'right'|'top'|'bottom'|'none'} legend
 * @property {boolean} valueLabels - draw the numeric value / percentage on marks.
 * @property {boolean} [trendLine] - scatter: draw the regression line.
 * @property {number} [pointSize] - scatter: point radius.
 * @property {number} [pieRotation] - pie: start-angle offset in degrees.
 * @property {boolean} [gridlines] - show gridlines (default true).
 * @property {boolean} [pointOverlay] - categorical: overlay raw data points on bars.
 * @property {'none'|'sem'|'sd'|'ci95'} [errorBars] - categorical: error bar type.
 * @property {string} [titleText] - override model.title.
 * @property {number} [titleSize] - title font size (default 15).
 * @property {boolean} [titleBold] - title bold (default true).
 * @property {boolean} [titleItalic] - title italic.
 * @property {string} [xAxisTitle] - override model.axes.x.title.
 * @property {number} [xAxisTitleSize] - x-axis title font size (default 12).
 * @property {boolean} [xAxisTitleBold] - x-axis title bold.
 * @property {boolean} [xAxisTitleItalic] - x-axis title italic.
 * @property {string} [yAxisTitle] - override model.axes.y.title.
 * @property {number} [yAxisTitleSize] - y-axis title font size (default 12).
 * @property {boolean} [yAxisTitleBold] - y-axis title bold.
 * @property {boolean} [yAxisTitleItalic] - y-axis title italic.
 * @property {number} [yAxisMin] - user override for y-axis minimum.
 * @property {number} [yAxisMax] - user override for y-axis maximum.
 * @property {number} [xAxisMin] - scatter: user override for x-axis minimum.
 * @property {number} [xAxisMax] - scatter: user override for x-axis maximum.
 * @property {number} [valueLabelSize] - value label font size.
 * @property {boolean} [valueLabelBold] - value labels bold.
 * @property {boolean} [valueLabelItalic] - value labels italic.
 *
 * @typedef {Object} ControlDescriptor
 * @property {string} id
 * @property {string} label
 * @property {'select'|'check'|'number'|'text'} type
 * @property {[string,string][]|((model:ChartModel)=>[string,string][])} [options] - for select.
 * @property {number} [min] @property {number} [max] @property {number} [step] - for number.
 * @property {(view:ViewState)=>*} get
 * @property {(view:ViewState, value:*)=>void} set
 * @property {(view:ViewState, model:ChartModel)=>boolean} [visible]
 * @property {boolean} [structural] - changing it re-lays-out the controls panel.
 */

// The kind modules are imported for their SIDE EFFECT: each calls registerChartKind at
// module scope. Adding a chart type is adding a file and a line here — the renderer,
// the controls panel, persistence and export all pick it up with no further changes.
//
// Import order is the order kinds appear in any UI that enumerates the registry, so it
// is grouped by family rather than alphabetically.
import './charts/kinds/categorical.js';
import './charts/kinds/scatter.js';
import './charts/kinds/pie.js';
import './charts/kinds/distribution.js';
import './charts/kinds/box.js';
import './charts/kinds/steps.js';
import './charts/kinds/forest.js';
import './charts/kinds/sced.js';
import './charts/kinds/wordcloud.js';

export {
  // Model → SVG, and the view state that drives it.
  renderChart,
  defaultView,
  chartUiSpec,
  // The registry, for kinds registering themselves — and for the results pane, which
  // asks whether a saved chart's kind still exists before trying to re-render it.
  registerChartKind,
  getChartKind,
  // Palettes.
  PALETTES,
  DEFAULT_PALETTE,
  colorFor,
  // Shared control descriptors, reusable by any kind.
  paletteControl,
  legendControl,
  valueLabelsControl,
  gridlinesControl,
} from './charts/runtime.js';
