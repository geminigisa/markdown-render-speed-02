// Driver for the fast renderer: it loads every markdown case, converts each
// one through the local parse implementation, and stores the resulting HTML
// strings in order. Paths come from the environment when the harness sets
// them, falling back to the container defaults used by the grader.
import { readFileSync as readText, writeFileSync as writeText } from 'node:fs';
import { join as joinPath } from 'node:path';
import { parse as renderMarkdown } from './parse.js';
type MarkdownCase = { id: string; markdown: string };
const sourceDir: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const targetDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
function renderAll(entries: MarkdownCase[], convert: (text: string) => string): string[] {
  return entries.map((entry: MarkdownCase): string => convert(entry.markdown));
}
const rawCases: string = readText(joinPath(sourceDir, 'cases.json'), 'utf8');
const parsedCases: MarkdownCase[] = JSON.parse(rawCases) as MarkdownCase[];
const renderedHtml: string[] = renderAll(parsedCases, renderMarkdown);
writeText(joinPath(targetDir, 'html.json'), JSON.stringify(renderedHtml));
