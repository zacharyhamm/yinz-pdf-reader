// PDF reader -- renders PDF pages inside a yinz pane with the kitty graphics
// protocol, using unicode placeholders so the image lives in the pane's cell
// grid: it clips, scrolls and moves with the pane like ordinary text.
//
// Pages are rasterised with `mutool draw` (falling back to `pdftoppm`) and page
// geometry comes from `pdfinfo`. Search runs over text `pdftotext` extracts in
// the background when a document opens; matches are located with
// `pdftotext -bbox` and painted onto the page by a small `mutool run` script.
//
// Open a file:
//   yinz plugin -c file=/path/to/doc.pdf -- file:$PWD/main.ts
//   yinz pipe --plugin file:$PWD/main.ts --name open -- /path/to/doc.pdf
// or press `o` inside the pane and type a path.
//
// Keys: j/k ↓/↑ scroll (or page in fit-page mode), d/u half-screen scroll,
// Space/PgDn/n/l next page, Backspace/PgUp/p/h previous page, g/G first/last,
// <number>Enter go to page, f toggle fit page / fit width, i invert colours,
// r reload, o open, q/Esc close. The mouse wheel scrolls. / searches; while a
// search is active n/N go to the next/previous match and Esc clears it. t opens
// the table of contents. <number>Enter goes to a printed page label when the
// PDF has one, and each file reopens where it was left.
import z, {definePlugin} from 'yinz:plugin';

type Fit = 'page' | 'width';

interface Doc {
  readonly path: string;
  readonly title: string;
  readonly pages: number;
  /** Page sizes in points, already swapped for 90/270 rotation. Index 0 is page 1. */
  readonly sizes: readonly (readonly [number, number])[];
}

interface Raster {
  readonly key: string;
  readonly png: Uint8Array;
}

interface Box {
  readonly w: number;
  readonly h: number;
}

/** A highlight rectangle in points from the crop box's top-left: x0, y0, x1, y1. */
type Rect = readonly [number, number, number, number];

interface Hit {
  readonly page: number;
  /** Which occurrence on its page, counting from 0. */
  readonly k: number;
}

interface Search {
  /** Distinguishes this search from later ones with the same query. */
  readonly id: number;
  readonly query: string;
  readonly re: RegExp;
  hits: Hit[];
  index: number;
}

interface Entry {
  readonly title: string;
  readonly depth: number;
  /** 1-based; outline entries that resolve to no page are dropped. */
  readonly page: number;
}

interface Position {
  readonly page: number;
  readonly scroll: number;
  readonly fit: Fit;
  readonly invert: boolean;
}

const LETTER: readonly [number, number] = [612, 792];
const CACHE_LIMIT = 12;

// Cell geometry is not exposed to plugins, so assume a typical terminal cell
// (a little under twice as tall as wide) and render at twice that density.
// The host scales the raster to the real cells, keeping its aspect ratio, so a
// wrong guess costs only a little margin; erring large means hidpi cells
// (around 23x43 px) are scaled down rather than blurred up.
let cellWidthPx = 12;
let cellHeightPx = 22;
let density = 2;

let doc: Doc | null = null;
let page = 1;
let fit: Fit = 'page';
let invert = false;
// Rows scrolled into the page in fit-width mode.
let scroll = 0;
let status = '';
let error = '';
let digits = '';
let opening = false;
const pathInput = z.ui.textInput({label: 'open: '});
let searching = false;
const searchInput = z.ui.textInput({label: '/'});
// Each page's text with whitespace collapsed, or null until indexed.
let texts: string[] | null = null;
let search: Search | null = null;
let searchId = 0;
// A query submitted before the text was indexed.
let queued = '';
// A one-off search message ("no matches", "wrapped"), cleared on the next key.
let notice = '';
// Each page's occurrence rectangles for the active search, one rect per word.
const boxes = new Map<number, Rect[][]>();
const boxesPending = new Set<number>();
// Scroll the current match into view once its page's boxes arrive.
let revealPending = false;
// The outline and printed page labels, read with mutool after a document opens.
let outline: readonly Entry[] = [];
// Printed labels by page (index 0 is page 1), or null when they are just the page numbers.
let labels: readonly string[] | null = null;
let metaReady = false;
let contents = false;
let tocIndex = 0;
let tocTop = 0;
// The position last written to the data store, to skip unchanged writes.
let saved = '';
let renderer: 'mutool' | 'pdftoppm' = 'mutool';
let homeDir = '';
let lastRows = 0;
let lastCols = 0;
let requested = '';

// The host does not deduplicate transmissions, so remember which raster each
// client last received and only transmit when that changes. Each new raster
// gets a fresh image id (re-sending under an existing id would replace the
// image and drop its placement); the previous one is deleted explicitly so
// the host's image store stays small however far you page.
let nextId = 1 + Math.floor(Math.random() * (z.ui.image.maxId - 1_000_000));
const shown = new Map<number, {id: number; key: string}>();
const cache = new Map<string, Raster>();
const pending = new Map<string, Promise<Raster | null>>();

function background(job: Promise<unknown>): void {
  job.catch((error_: unknown) => {
    error = String(error_);
    z.requestRender();
  });
}

function resolvePath(path: string): string {
  let p = path.trim();
  if (p.startsWith('~/')) p = homeDir + p.slice(1);
  if (!p.startsWith('/')) p = `${z.getPluginIds().initial_cwd.replace(/\/$/u, '')}/${p}`;
  return p;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

async function run(command: readonly string[]): Promise<{ok: boolean; stdout: Uint8Array; stderr: string}> {
  const result = await z.runCommand({command: [...command], maxBytesReturned: 64 * 1024 * 1024});
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout,
    stderr: z.decodeUtf8(result.stderr).trim(),
  };
}

function fail(message: string): void {
  error = message;
  status = '';
  z.requestRender();
}

/** Per-page sizes and rotations, so mixed-size documents lay out correctly. */
async function pageSizes(path: string, pages: number): Promise<(readonly [number, number])[]> {
  const sizes: (readonly [number, number])[] = Array.from({length: pages}, () => LETTER);
  const detail = z.decodeUtf8((await run(['pdfinfo', '-f', '1', '-l', String(pages), path])).stdout);
  const rots = new Map<number, number>();
  for (const m of detail.matchAll(/^Page\s+(\d+)\s+rot:\s+(\d+)/gmu)) rots.set(Number(m[1]), Number(m[2]));
  for (const m of detail.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+) x ([\d.]+)/gmu)) {
    const n = Number(m[1]);
    const w = Number(m[2]);
    const h = Number(m[3]);
    sizes[n - 1] = (rots.get(n) ?? 0) % 180 === 0 ? [w, h] : [h, w];
  }
  return sizes;
}

async function openDoc(path: string, keepPage = false): Promise<void> {
  const full = resolvePath(path);
  error = '';
  status = `opening ${basename(full)}…`;
  z.requestRender();
  const info = await run(['pdfinfo', full]);
  if (!info.ok) {
    fail(info.stderr === '' ? `pdfinfo failed for ${full}` : info.stderr);
    return;
  }
  const text = z.decodeUtf8(info.stdout);
  const pages = Number(/^Pages:\s+(\d+)/mu.exec(text)?.[1] ?? 0);
  const title = /^Title:\s+(.+)$/mu.exec(text)?.[1]?.trim() ?? '';
  if (pages < 1) {
    fail(`no pages in ${full}`);
    return;
  }
  const sizes = await pageSizes(full, pages);
  cache.clear();
  pending.clear();
  requested = '';
  // A reload searches the fresh text for the same query.
  queued = keepPage ? (search?.query ?? queued) : '';
  clearSearch();
  texts = null;
  doc = {path: full, title: title === '' ? basename(full) : title, pages, sizes};
  outline = [];
  labels = null;
  metaReady = false;
  contents = false;
  if (keepPage) {
    page = Math.min(page, pages);
  } else {
    const last = recall(full);
    page = Math.min(pages, Math.max(1, last?.page ?? 1));
    scroll = last?.scroll ?? 0;
    if (last) {
      fit = last.fit;
      invert = last.invert;
    }
  }
  saved = '';
  status = '';
  background(indexText(doc));
  background(loadMeta(doc));
  z.requestRender();
}

const POSITIONS = 'position';

/** Where `path` was left, from the plugin's private data store. */
function recall(path: string): Position | null {
  try {
    const row = z.data.fetch({entity: POSITIONS, filter: z.data.eq('path', path), limit: 1}).records[0];
    if (!row) return null;
    return {
      page: Number(row['page'] ?? 1),
      scroll: Number(row['scroll'] ?? 0),
      fit: row['fit'] === 'width' ? 'width' : 'page',
      invert: row['invert'] === true,
    };
  } catch (error_: unknown) {
    z.log(`could not read the saved position: ${String(error_)}`);
    return null;
  }
}

/** Save the current position when it has changed. */
function remember(): void {
  if (!doc) return;
  const now = `${page}:${scroll}:${fit}:${invert}`;
  if (now === saved) return;
  saved = now;
  try {
    z.data.apply([z.data.put(POSITIONS, {path: doc.path, page, scroll, fit, invert}, {uid: doc.path})]);
  } catch (error_: unknown) {
    z.log(`could not save the position: ${String(error_)}`);
  }
}

// Prints the outline, flattened with depths and resolved to 1-based pages, and
// each page's label as JSON. Arguments: unused output file, document.
const META_SCRIPT = `
var d = Document.openDocument(scriptArgs[1]);
var out = {outline: [], labels: []};
function walk(items, depth) {
  for (var i = 0; i < items.length; i++) {
    var item = items[i], target = -1;
    try { if (item.uri) target = d.resolveLink(item.uri); } catch (e) {}
    out.outline.push({title: item.title || '', depth: depth, page: target + 1});
    if (item.down) walk(item.down, depth + 1);
  }
}
var o = d.loadOutline();
if (o) walk(o, 0);
for (var i = 0, n = d.countPages(); i < n; i++) out.labels.push(d.loadPage(i).getLabel() || '');
print(JSON.stringify(out));
`;

async function loadMeta(current: Doc): Promise<void> {
  const result = renderer === 'mutool' ? await run(mutoolRun(META_SCRIPT, [current.path], false)) : null;
  if (doc !== current) return;
  metaReady = true;
  if (!result?.ok) {
    if (result) z.log(`could not read the outline: ${result.stderr}`);
    z.requestRender();
    return;
  }
  const meta: unknown = JSON.parse(z.decodeUtf8(result.stdout));
  const entries = field(meta, 'outline');
  const found = field(meta, 'labels');
  outline = (Array.isArray(entries) ? entries : []).map((entry: unknown) => {
    const title = field(entry, 'title');
    return {title: typeof title === 'string' ? title : '', depth: Number(field(entry, 'depth')), page: Number(field(entry, 'page'))};
  }).filter(entry => entry.page >= 1 && entry.page <= current.pages);
  const printed = (Array.isArray(found) ? found : []).map((label: unknown) => (typeof label === 'string' ? label : ''));
  labels = printed.every((label, i) => label === '' || label === String(i + 1)) ? null : printed;
  z.requestRender();
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/** The page whose printed label is `label`, if the PDF has labels. */
function labelledPage(label: string): number | null {
  const i = labels?.indexOf(label) ?? -1;
  return i === -1 ? null : i + 1;
}

function pageLabel(n: number): string {
  const label = labels?.[n - 1] ?? '';
  return label === '' ? String(n) : label;
}

/**
 * Wrap a mutool run script so it can be passed inline: mutool run needs a
 * script file and cannot write a PNG to stdout, and plugins cannot remove files
 * when they unload, so each run gets its own directory. The script's first
 * argument is a PNG path, printed afterwards when `png` is set.
 */
function mutoolRun(script: string, args: readonly string[], png: boolean): string[] {
  const cat = png ? ' && cat "$d/p.png"' : '';
  const sh = `d=$(mktemp -d) || exit 1; trap 'rm -rf "$d"' EXIT; printf %s "$0" > "$d/s.js" && mutool run "$d/s.js" "$d/p.png" "$@"${cat}`;
  return ['sh', '-c', sh, script, ...args];
}

function clearSearch(): void {
  search = null;
  boxes.clear();
  boxesPending.clear();
  revealPending = false;
}

async function indexText(current: Doc): Promise<void> {
  const result = await run(['pdftotext', '-cropbox', '-enc', 'UTF-8', current.path, '-']);
  if (doc !== current) return;
  if (!result.ok) {
    queued = '';
    notice = `search unavailable: ${result.stderr === '' ? 'pdftotext failed' : result.stderr}`;
    z.requestRender();
    return;
  }
  // Pages end with a form feed, so the text after the last one is empty.
  const parts = z.decodeUtf8(result.stdout).split('\f');
  texts = Array.from({length: current.pages}, (_, i) => (parts[i] ?? '').replaceAll(/\s+/gu, ' '));
  if (queued !== '') {
    const query = queued;
    queued = '';
    startSearch(query);
  }
  z.requestRender();
}

/** Smart case: the query ignores case unless it has an uppercase letter. */
function matcher(query: string): RegExp | null {
  const words = query.trim().split(/\s+/u).filter(word => word !== '');
  if (words.length === 0) return null;
  const source = words.map(word => word.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)).join(String.raw`\s+`);
  return new RegExp(source, /\p{Lu}/u.test(query) ? 'gu' : 'giu');
}

function startSearch(query: string): void {
  const re = matcher(query);
  if (!re || !doc) return;
  clearSearch();
  if (!texts) {
    queued = query;
    return;
  }
  const hits: Hit[] = [];
  for (const [i, text] of texts.entries()) {
    const count = text.match(re)?.length ?? 0;
    for (let k = 0; k < count; k += 1) hits.push({page: i + 1, k});
  }
  if (hits.length === 0) {
    notice = `no matches for "${query}"`;
    return;
  }
  searchId += 1;
  search = {id: searchId, query, re, hits, index: 0};
  // Search forward from the current page, wrapping past the end.
  const first = hits.findIndex(hit => hit.page >= page);
  gotoHit(first === -1 ? 0 : first, first === -1);
}

function decodeXml(text: string): string {
  const entities: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
  return text.replaceAll(/&(amp|lt|gt|quot|apos);/gu, (_, name: string) => entities[name] ?? '');
}

const WORD = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/word>/gu;

/**
 * Locate page `n`'s occurrences of the active search. The words are joined
 * with single spaces, as the indexed text was, and a match covering part of a
 * word gets the matching fraction of that word's box.
 */
async function loadBoxes(current: Doc, id: number, n: number): Promise<void> {
  boxesPending.add(n);
  const result = await run(['pdftotext', '-cropbox', '-bbox', '-f', String(n), '-l', String(n), current.path, '-']);
  boxesPending.delete(n);
  const active = search;
  if (doc !== current || active?.id !== id) return;
  if (!result.ok) {
    // Keep the indexed matches; the page just goes without highlights.
    z.log(`pdftotext -bbox failed for page ${n}: ${result.stderr}`);
    boxes.set(n, []);
    return;
  }
  let joined = '';
  const words: {start: number; end: number; rect: Rect}[] = [];
  for (const m of z.decodeUtf8(result.stdout).matchAll(WORD)) {
    const text = decodeXml(m[5] ?? '');
    if (joined !== '') joined += ' ';
    words.push({start: joined.length, end: joined.length + text.length, rect: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]});
    joined += text;
  }
  const found: Rect[][] = [];
  for (const m of joined.matchAll(active.re)) {
    const start = m.index;
    const end = start + m[0].length;
    found.push(words.filter(word => word.end > start && word.start < end).map(({start: ws, end: we, rect: [x0, y0, x1, y1]}) => {
      const scale = (x1 - x0) / Math.max(1, we - ws);
      return [x0 + Math.max(0, start - ws) * scale, y0, x0 + (Math.min(we, end) - ws) * scale, y1] as const;
    }));
  }
  boxes.set(n, found);
  reconcile(n, found.length);
  if (revealPending) revealHit();
  z.requestRender();
}

/** Trust the positioned count for page `n` if it disagrees with the index. */
function reconcile(n: number, count: number): void {
  const active = search;
  if (!active) return;
  const before = active.hits.filter(hit => hit.page < n);
  const after = active.hits.filter(hit => hit.page > n);
  const old = active.hits.length - before.length - after.length;
  if (old === count) return;
  const current = active.hits[active.index];
  active.hits = [...before, ...Array.from({length: count}, (_, k) => ({page: n, k})), ...after];
  if (active.hits.length === 0) {
    clearSearch();
    notice = `no matches for "${active.query}"`;
    return;
  }
  if (current && current.page === n) active.index = before.length + Math.min(current.k, count - 1);
  else if (current && current.page > n) active.index += count - old;
  active.index = Math.min(active.hits.length - 1, Math.max(0, active.index));
}

/** The placement box, in cells, for page `n` in the current mode. */
function layout(current: Doc, n: number, rows: number, cols: number): Box {
  const [pw, ph] = current.sizes[n - 1] ?? LETTER;
  const max = z.ui.image.maxDimension;
  const widthFor = (h: number): number => Math.max(1, Math.round((h * cellHeightPx * pw) / (ph * cellWidthPx)));
  let w = Math.max(1, Math.min(cols, max));
  let h = Math.max(1, Math.round((w * cellWidthPx * ph) / (pw * cellHeightPx)));
  if (fit === 'page' && h > rows) {
    h = Math.max(1, Math.min(rows, max));
    w = Math.min(w, widthFor(h));
  }
  if (h > max) {
    h = max;
    w = widthFor(h);
  }
  return {w, h};
}

interface Highlight {
  readonly key: string;
  /** [x0, y0, x1, y1, current] per rectangle, as JSON for the script. */
  readonly marks: string;
}

/** Page `n`'s highlights, once its matches are located; mutool only. */
function highlight(n: number): Highlight | null {
  const found = boxes.get(n);
  if (!search || renderer !== 'mutool' || !found || found.length === 0) return null;
  const hit = search.hits[search.index];
  const current = hit?.page === n ? hit.k : -1;
  const marks = found.flatMap((rects, k) => rects.map(rect => [...rect, k === current ? 1 : 0]));
  return {key: `${search.query}#${current}`, marks: JSON.stringify(marks)};
}

// Renders a page like `mutool draw -w -h` and fills translucent rectangles over
// the matches, after inverting so the colours survive. Arguments: output file,
// document, page, pixel width and height, invert (1/0), marks JSON.
const HIGHLIGHT_SCRIPT = `
var a = scriptArgs;
var page = Document.openDocument(a[1]).loadPage(Number(a[2]) - 1);
var b = page.getBounds();
var s = Math.min(Number(a[3]) / (b[2] - b[0]), Number(a[4]) / (b[3] - b[1]));
var pix = page.toPixmap(Matrix.scale(s, s), ColorSpace.DeviceRGB, false);
if (a[5] === '1') pix.invert();
var dev = new DrawDevice(Matrix.identity, pix);
var marks = JSON.parse(a[6]);
for (var i = 0; i < marks.length; i++) {
  var m = marks[i], path = new Path();
  path.rect((m[0] - b[0]) * s, (m[1] - b[1]) * s, (m[2] - b[0]) * s, (m[3] - b[1]) * s);
  dev.fillPath(path, false, Matrix.identity, ColorSpace.DeviceRGB, m[4] ? [1, 0.55, 0] : [1, 0.85, 0], m[4] ? 0.5 : 0.35);
}
dev.close();
pix.asPNG().save(a[0]);
`;

function rasterKey(n: number, box: Box, hl: Highlight | null = highlight(n)): string {
  return `${n}:${box.w}x${box.h}:${invert ? 'i' : ''}${hl ? `:${hl.key}` : ''}`;
}

function rasterCommand(path: string, n: number, box: Box, hl: Highlight | null): string[] {
  const pxW = String(box.w * cellWidthPx * density);
  const pxH = String(box.h * cellHeightPx * density);
  if (hl) return mutoolRun(HIGHLIGHT_SCRIPT, [path, String(n), pxW, pxH, invert ? '1' : '0', hl.marks], true);
  if (renderer === 'mutool') {
    const flags = invert ? ['-I'] : [];
    return ['mutool', 'draw', '-q', '-F', 'png', '-o', '-', '-w', pxW, '-h', pxH, ...flags, path, String(n)];
  }
  return ['pdftoppm', '-png', '-f', String(n), '-l', String(n), '-scale-to-x', pxW, '-scale-to-y', '-1', path];
}

async function rasterize(current: Doc, n: number, box: Box): Promise<Raster | null> {
  const hl = highlight(n);
  const key = rasterKey(n, box, hl);
  const hit = cache.get(key);
  if (hit) return hit;
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const job = (async (): Promise<Raster | null> => {
    let result = await run(rasterCommand(current.path, n, box, hl));
    if (!result.ok && renderer === 'mutool' && !hl) {
      z.log(`mutool failed (${result.stderr}); falling back to pdftoppm`);
      renderer = 'pdftoppm';
      result = await run(rasterCommand(current.path, n, box, null));
    }
    pending.delete(key);
    if (doc !== current) return null;
    if (!result.ok) {
      fail(result.stderr === '' ? `could not render page ${n}` : result.stderr);
      return null;
    }
    const raster: Raster = {key, png: result.stdout};
    cache.set(key, raster);
    for (const old of cache.keys()) {
      if (cache.size <= CACHE_LIMIT) break;
      cache.delete(old);
    }
    return raster;
  })();
  pending.set(key, job);
  return job;
}

function imageRows(): number {
  return Math.max(1, lastRows - 1);
}

function goTo(n: number): boolean {
  if (!doc) return false;
  const target = Math.min(doc.pages, Math.max(1, n));
  if (target === page) return false;
  page = target;
  scroll = 0;
  return true;
}

function gotoHit(i: number, wrapped = false): boolean {
  if (!search || !doc) return false;
  const hit = search.hits[i];
  if (!hit) return false;
  search.index = i;
  notice = wrapped ? 'search wrapped' : '';
  goTo(hit.page);
  revealHit();
  return true;
}

/** In fit-width mode, scroll the current match into view if it is off screen. */
function revealHit(): void {
  const hit = search?.hits[search.index];
  revealPending = false;
  if (!doc || !hit || hit.page !== page || fit !== 'width') return;
  const rect = boxes.get(page)?.[hit.k]?.[0];
  if (!rect) {
    revealPending = true;
    return;
  }
  const rows = imageRows();
  const box = layout(doc, page, rows, lastCols);
  const ph = (doc.sizes[page - 1] ?? LETTER)[1];
  const top = Math.floor((rect[1] / ph) * box.h);
  const bottom = Math.ceil((rect[3] / ph) * box.h);
  if (top >= scroll && bottom <= scroll + rows) return;
  scroll = Math.min(Math.max(0, box.h - rows), Math.max(0, top - Math.floor(rows / 3)));
}

function nextMatch(delta: number): boolean {
  if (!search) return false;
  const count = search.hits.length;
  const i = search.index + delta;
  return gotoHit((i + count) % count, i < 0 || i >= count);
}

/** Scroll within the page in fit-width mode, spilling over to neighbouring pages. */
function scrollBy(delta: number): boolean {
  if (!doc) return false;
  if (fit === 'page') return goTo(page + Math.sign(delta));
  const rows = imageRows();
  const maxScroll = Math.max(0, layout(doc, page, rows, lastCols).h - rows);
  const next = scroll + delta;
  // Show the edge of the current page before spilling onto its neighbour.
  if (next < 0 && scroll > 0) {
    scroll = 0;
    return true;
  }
  if (next > maxScroll && scroll < maxScroll) {
    scroll = maxScroll;
    return true;
  }
  if (next < 0 && page > 1) {
    page -= 1;
    scroll = Math.max(0, layout(doc, page, rows, lastCols).h - rows);
    return true;
  }
  if (next > maxScroll && page < doc.pages) {
    page += 1;
    scroll = 0;
    return true;
  }
  const clamped = Math.min(maxScroll, Math.max(0, next));
  if (clamped === scroll) return false;
  scroll = clamped;
  return true;
}

function step(lines: number): number {
  return fit === 'width' ? lines : 1;
}

function half(): number {
  return Math.max(1, Math.floor(imageRows() / 2));
}

const ACTIONS: Record<string, () => boolean> = {
  j: () => scrollBy(step(2)),
  k: () => scrollBy(-step(2)),
  d: () => scrollBy(half()),
  u: () => scrollBy(-half()),
  n: () => goTo(page + 1),
  p: () => goTo(page - 1),
  g: () => goTo(1),
  G: () => goTo(doc?.pages ?? 1),
  f: () => {
    fit = fit === 'page' ? 'width' : 'page';
    scroll = 0;
    revealHit();
    return true;
  },
  i: () => {
    invert = !invert;
    return true;
  },
  r: () => {
    if (doc) background(openDoc(doc.path, true));
    return true;
  },
  t: openContents,
  o: () => {
    opening = true;
    pathInput.replaceText(doc?.path ?? '');
    return true;
  },
  q: () => {
    z.closeSelf();
    return false;
  },
};
const ALIASES: Record<string, string> = {
  Down: 'j', Up: 'k', ' ': 'n', Space: 'n', PageDown: 'n', l: 'n', Right: 'n',
  Backspace: 'p', PageUp: 'p', h: 'p', Left: 'p', Home: 'g', End: 'G', w: 'f', Esc: 'q',
};

function openContents(): boolean {
  if (outline.length === 0) {
    notice = metaReady ? 'no table of contents' : 'reading the table of contents…';
    return true;
  }
  contents = true;
  // Start on the section the current page is in.
  const after = outline.findIndex(entry => entry.page > page);
  tocIndex = Math.max(0, (after === -1 ? outline.length : after) - 1);
  return true;
}

function moveContents(delta: number): boolean {
  const next = Math.min(outline.length - 1, Math.max(0, tocIndex + delta));
  if (next === tocIndex) return false;
  tocIndex = next;
  return true;
}

function handleContentsKey(name: string): boolean {
  const jump = half();
  const moves: Record<string, number> = {
    j: 1, Down: 1, k: -1, Up: -1, d: jump, PageDown: jump, ' ': jump, Space: jump, u: -jump, PageUp: -jump,
    g: -outline.length, Home: -outline.length, G: outline.length, End: outline.length,
  };
  const move = moves[name];
  if (move !== undefined) return moveContents(move);
  if (name === 'Enter') {
    const entry = outline[tocIndex];
    contents = false;
    if (entry) goTo(entry.page);
    return true;
  }
  if (name === 'Esc' || name === 'q' || name === 't') {
    contents = false;
    return true;
  }
  return false;
}

function drawContents(rows: number, cols: number): string {
  const area = Math.max(1, rows - 1);
  tocTop = Math.min(tocIndex, Math.max(tocTop, tocIndex - area + 1));
  const lines: string[] = [];
  for (let y = 0; y < area; y += 1) {
    const i = tocTop + y;
    const entry = outline[i];
    if (!entry) {
      lines.push('');
      continue;
    }
    const right = ` ${pageLabel(entry.page)} `;
    const left = ` ${'  '.repeat(entry.depth)}${z.text.sanitize(entry.title)}`;
    const width = Math.max(0, cols - z.text.width(right));
    const line = z.text.pad(z.text.truncate(left, width), width) + right;
    lines.push(i === tocIndex ? `\u001B[7m${line}\u001B[27m` : line);
  }
  return `${lines.join('\n')}\n`;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- the SDK's key type is mutable.
function handleOpeningKey(key: Parameters<typeof pathInput.handleInputKey>[0]): boolean {
  const action = pathInput.handleInputKey(key);
  if (action === 'submit') {
    const path = pathInput.drainText();
    opening = false;
    if (path.trim() !== '') background(openDoc(path));
  } else if (action === 'cancel') {
    opening = false;
  }
  return true;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- the SDK's key type is mutable.
function handleSearchKey(key: Parameters<typeof searchInput.handleInputKey>[0]): boolean {
  const action = searchInput.handleInputKey(key);
  if (action === 'submit') {
    searching = false;
    startSearch(searchInput.drainText());
  } else if (action === 'cancel') {
    searching = false;
  }
  return true;
}

function handleKey(name: string, ctrl: boolean): boolean {
  const hadNotice = notice !== '';
  notice = '';
  return handleCommandKey(name, ctrl) || hadNotice;
}

function handleCommandKey(name: string, ctrl: boolean): boolean {
  if (/^[0-9]$/u.test(name) && !ctrl) {
    digits = (digits + name).slice(-6);
    return true;
  }
  if (digits !== '' && (name === 'Enter' || name === 'Esc')) {
    if (name === 'Enter') goTo(labelledPage(digits) ?? Number(digits));
    digits = '';
    return true;
  }
  const hadDigits = digits !== '';
  digits = '';
  if (name === '/' && !ctrl) {
    searching = true;
    searchInput.replaceText('');
    return true;
  }
  // While a search is active n/N step through matches and Esc ends the
  // search; Space, PgDn and the rest still page through their aliases.
  if ((search || queued !== '') && !ctrl) {
    if (name === 'n') return nextMatch(1);
    if (name === 'N') return nextMatch(-1);
    if (name === 'Esc') {
      queued = '';
      clearSearch();
      return true;
    }
  }
  const action = ACTIONS[ALIASES[name] ?? name];
  return action ? action() || hadDigits : hadDigits;
}

function statusText(): string {
  if (error !== '') return `\u001B[31m${error}\u001B[39m`;
  if (!doc) return status === '' ? 'no document — press o to open a PDF' : status;
  const mode = fit === 'page' ? 'fit page' : 'fit width';
  const printed = pageLabel(page) === String(page) ? '' : `p. ${pageLabel(page)}  `;
  let text = `\u001B[1m${doc.title}\u001B[22m  ${printed}${page}/${doc.pages}  ${mode}`;
  if (invert) text += '  inverted';
  if (digits !== '') text += `  go to: ${digits}`;
  const hit = search?.hits[search.index];
  if (search && hit) text += `  match ${search.index + 1}/${search.hits.length} · page ${hit.page}`;
  else if (queued !== '') text += '  indexing…';
  if (notice !== '') text += `  ${notice}`;
  if (status !== '') text += `  ${status}`;
  return text;
}

function statusLine(cols: number): string {
  if (opening) return pathInput.render({width: cols, height: 1});
  if (searching) return searchInput.render({width: cols, height: 1});
  const left = contents ? `\u001B[1mcontents\u001B[22m  ${tocIndex + 1}/${outline.length}` : statusText();
  const hint = contents
    ? 'j/k move  Enter go  Esc close'
    : search
    ? 'n/N match  Esc clear  Space/p page  / search  q quit'
    : 'j/k scroll  n/p page  / search  t contents  f fit  o open  q quit';
  const room = cols - z.text.width(left) - z.text.width(hint);
  const line = room >= 2 ? left + ' '.repeat(room) + hint : left;
  return `\u001B[7m${z.text.pad(z.text.truncate(line, cols), cols)}\u001B[0m`;
}

function placeholder(message: string, area: number, cols: number): string {
  const top = Math.floor(area / 2);
  return '\n'.repeat(top) + z.text.center(message, cols) + '\n'.repeat(area - top);
}

function prefetch(current: Doc, area: number, cols: number): void {
  for (const n of [page + 1, page - 1]) {
    if (n >= 1 && n <= current.pages) background(rasterize(current, n, layout(current, n, area, cols)));
  }
}

/** Start locating the current page's matches when it has some. */
function locateMatches(current: Doc): void {
  if (!search || renderer !== 'mutool' || boxes.has(page) || boxesPending.has(page)) return;
  if (search.hits.some(hit => hit.page === page)) background(loadBoxes(current, search.id, page));
}

/** A raster of the current page to show while its highlights are drawn. */
function standIn(box: Box): Raster | undefined {
  const sent = shown.get(z.getPluginIds().client_id);
  const sameBox = sent?.key.startsWith(`${page}:${box.w}x${box.h}:${invert ? 'i' : ''}`) === true;
  return cache.get(rasterKey(page, box, null)) ?? (sent && sameBox ? cache.get(sent.key) : undefined);
}

function drawPage(current: Doc, rows: number, cols: number): string {
  const area = Math.max(1, rows - 1);
  const box = layout(current, page, area, cols);
  scroll = fit === 'width' ? Math.min(scroll, Math.max(0, box.h - area)) : 0;
  locateMatches(current);
  const key = rasterKey(page, box);
  const ready = cache.get(key);
  if (ready) {
    prefetch(current, area, cols);
  } else if (requested !== key) {
    requested = key;
    background(rasterize(current, page, box).then(() => {
      z.requestRender();
    }));
  }
  const raster = ready ?? standIn(box);
  if (!raster) return placeholder(`rendering page ${page}…`, area, cols);

  const client = z.getPluginIds().client_id;
  let head = '';
  let sent = shown.get(client);
  if (sent?.key !== raster.key) {
    if (sent) head = `\u001B_Ga=d,d=I,i=${sent.id},q=2\u001B\\`;
    sent = {id: nextId, key: raster.key};
    nextId += 1;
    head += z.ui.image.transmitPng(sent.id, raster.png) + z.ui.image.place(sent.id, box.w, box.h);
    shown.set(client, sent);
  }
  const pad = ' '.repeat(Math.max(0, Math.floor((cols - box.w) / 2)));
  const top = fit === 'page' ? Math.max(0, Math.floor((area - box.h) / 2)) : 0;
  const lines: string[] = [];
  for (let y = 0; y < area; y += 1) {
    const r = y - top + scroll;
    lines.push(r >= 0 && r < box.h ? pad + z.ui.image.row(sent.id, r, box.w) : '');
  }
  lines[0] = head + (lines[0] ?? '');
  return `${lines.join('\n')}\n`;
}

async function detectTools(): Promise<void> {
  const probe = await run(['sh', '-c', 'echo "$HOME"; command -v mutool || true']);
  const [home = '', mutool = ''] = z.decodeUtf8(probe.stdout).split('\n');
  homeDir = home;
  if (mutool === '') renderer = 'pdftoppm';
}

const DEFAULTS = {file: '', cell_width: '12', cell_height: '22', density: '2', fit: 'page', invert: 'false'};

/**
 * The `file` setting, percent-decoded. `yinz plugin -c` splits on every comma,
 * so a path containing one arrives cut short, its remainder turned into
 * value-less keys in no reliable order; say how to pass it instead of failing
 * to open half a path.
 */
function configuredFile(config: Readonly<Record<string, string>>): string {
  const stray = Object.keys(config).filter(key => !(key in DEFAULTS) && config[key] === '');
  if (stray.length > 0) {
    fail('file path contains a comma: write it as %2C, press o, or use `yinz pipe --name open`');
    return '';
  }
  const file = config['file'] ?? '';
  try {
    return decodeURIComponent(file);
  } catch {
    return file;
  }
}

export default definePlugin({
  defaults: DEFAULTS,
  async load(config) {
    cellWidthPx = Number(config['cell_width']) || cellWidthPx;
    cellHeightPx = Number(config['cell_height']) || cellHeightPx;
    density = Number(config['density']) || density;
    fit = config['fit'] === 'width' ? 'width' : 'page';
    invert = config['invert'] === 'true';
    await z.waitForPermissions(['RunCommands', 'PluginData']);
    z.data.define(POSITIONS, {
      path: {kind: 'Text', required: true, unique: true},
      page: {kind: 'Int', required: true},
      scroll: 'Int',
      fit: 'Text',
      invert: 'Bool',
    });
    z.subscribe(['Key', 'Mouse', 'ClientGridReset']);
    await detectTools();
    const file = configuredFile(config);
    if (file !== '') await openDoc(file);
  },
  update(event) {
    if (typeof event !== 'object') return false;
    if ('ClientGridReset' in event) {
      shown.delete(event.ClientGridReset);
      return true;
    }
    if ('Key' in event) {
      if (opening) return handleOpeningKey(event.Key);
      if (searching) return handleSearchKey(event.Key);
      if (contents) return handleContentsKey(z.keyName(event.Key.bare_key));
      return handleKey(z.keyName(event.Key.bare_key), event.Key.key_modifiers.includes('Ctrl'));
    }
    if ('Mouse' in event) {
      if ('ScrollDown' in event.Mouse) return contents ? moveContents(3) : scrollBy(step(3));
      if ('ScrollUp' in event.Mouse) return contents ? moveContents(-3) : scrollBy(-step(3));
    }
    return false;
  },
  pipe(message) {
    if (message.name !== 'open' || message.payload === null) return false;
    background(openDoc(message.payload));
    return true;
  },
  render(rows, cols) {
    lastRows = rows;
    lastCols = cols;
    let body = '\n'.repeat(Math.max(0, rows - 1));
    if (doc) body = contents ? drawContents(rows, cols) : drawPage(doc, rows, cols);
    // Every change of position is followed by a render, so save it here.
    remember();
    return body + statusLine(cols);
  },
});
