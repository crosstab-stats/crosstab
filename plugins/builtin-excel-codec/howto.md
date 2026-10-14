# builtin-excel-codec - how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: codec-excel
**File ▸ Import data…** (or **Export data…**), then choose **Excel (.xlsx / .xls)**.

Import reads a worksheet as a table: the **first row is the header**, one column per spreadsheet column. A multi-sheet workbook asks which sheet you want. Export writes the current dataset to a single-sheet `.xlsx`.

The usual trouble with spreadsheets is not the format but the layout: merged cells, a title above the header row, several tables on one sheet, or notes in the margin. Tidy the sheet to one header row and one table before importing, and the import becomes uneventful.
