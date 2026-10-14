/**
 * @file syntax-guide.js
 * The Syntax guide, which is now a VIEW of the how-to index rather than a dialog of its
 * own (#192).
 *
 * ## What was wrong with the dialog
 *
 * The owner's list, after using it: it opened fully expanded instead of as an index; it
 * had no top bar, so there was no Back and nothing said which topic you were reading; it
 * put the command reference ABOVE the search box; it showed one card per PLUGIN, so the
 * pie chart's entry carried bar-chart notes; it could not cross-link; and its close button
 * was ~16×19px — *"so small I missed tapping it five times in a row"* — because it was
 * styled inline, which is also why no small-screen rule could ever have resized it.
 *
 * Every one of those is a property of being a separate dialog with its own layout. The
 * fix is therefore not to adjust it but to stop having one: the fourteen commands are now
 * core-owned how-to topics in the single index, searchable beside the GUI topics, so
 * "how do I recode" finds the `recode` command and *Recode a variable into groups*
 * together. A separate dialog could never have done that.
 *
 * The live plugin list it also carried is gone for the same reason it was a problem: it
 * was one entry per plugin. A plugin's own topics now say how to call it, and a plugin
 * that has not written any still contributes the one-line `howto` it already had, as a
 * topic (see the legacy bridge in howto.js). So nothing is lost and nothing is mixed.
 *
 * This module stays as the named entry point — `Help ▸ Syntax guide…` and the ❓ in the
 * script editor both still mean something specific — and opens the guide at the Syntax
 * category.
 */

import { openHowto } from './howto-ui.js';

/** The category the command reference files itself under, in core's own index. */
export const SYNTAX_CATEGORY = 'Syntax';

/**
 * Open the guide showing the command reference.
 *
 * @param {{library: object}} deps the how-to library. Kept as a parameter rather than
 *   reached for globally so this stays as testable and as replaceable as the rest.
 */
export function openSyntaxGuide({ library } = {}) {
  if (!library) return null;
  // The INDEX restricted to the Syntax category, rather than at one topic: the command
  // reference is a list you browse. An exact category rather than a text search, because
  // searching for the word would also return every plugin NAMED "... Syntax ..." — which
  // is right for a search box and wrong for a menu item that promises one specific thing.
  return openHowto({ library, category: SYNTAX_CATEGORY });
}
