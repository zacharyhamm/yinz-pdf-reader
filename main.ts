// PDF reader -- renders PDF pages inside a yinz pane with the kitty graphics
// protocol, using unicode placeholders so the image lives in the pane's cell
// grid: it clips, scrolls and moves with the pane like ordinary text.
//
// Pages are rasterised with `mutool draw` (falling back to `pdftoppm`) and page
// geometry comes from `pdfinfo`.
//
// Open a file:
//   yinz plugin -c file=/path/to/doc.pdf -- file:$PWD/main.ts
//   yinz pipe --plugin file:$PWD/main.ts --name open -- /path/to/doc.pdf
// or press `o` inside the pane and type a path.
//
// Keys: j/k ↓/↑ scroll (or page in fit-page mode), d/u half-screen scroll,
// Space/PgDn/n/l next page, Backspace/PgUp/p/h previous page, g/G first/last,
// <number>Enter go to page, f toggle fit page / fit width, i invert colours,
// r reload, o open, q/Esc close. The mouse wheel scrolls.
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
  doc = {path: full, title: title === '' ? basename(full) : title, pages, sizes};
  page = keepPage ? Math.min(page, pages) : 1;
  if (!keepPage) scroll = 0;
  status = '';
  z.requestRender();
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

function rasterKey(n: number, box: Box): string {
  return `${n}:${box.w}x${box.h}:${invert ? 'i' : ''}`;
}

function rasterCommand(path: string, n: number, box: Box): string[] {
  const pxW = String(box.w * cellWidthPx * density);
  const pxH = String(box.h * cellHeightPx * density);
  if (renderer === 'mutool') {
    const flags = invert ? ['-I'] : [];
    return ['mutool', 'draw', '-q', '-F', 'png', '-o', '-', '-w', pxW, '-h', pxH, ...flags, path, String(n)];
  }
  return ['pdftoppm', '-png', '-f', String(n), '-l', String(n), '-scale-to-x', pxW, '-scale-to-y', '-1', path];
}

async function rasterize(current: Doc, n: number, box: Box): Promise<Raster | null> {
  const key = rasterKey(n, box);
  const hit = cache.get(key);
  if (hit) return hit;
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const job = (async (): Promise<Raster | null> => {
    let result = await run(rasterCommand(current.path, n, box));
    if (!result.ok && renderer === 'mutool') {
      z.log(`mutool failed (${result.stderr}); falling back to pdftoppm`);
      renderer = 'pdftoppm';
      result = await run(rasterCommand(current.path, n, box));
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

function handleKey(name: string, ctrl: boolean): boolean {
  if (/^[0-9]$/u.test(name) && !ctrl) {
    digits = (digits + name).slice(-6);
    return true;
  }
  if (digits !== '' && (name === 'Enter' || name === 'Esc')) {
    if (name === 'Enter') goTo(Number(digits));
    digits = '';
    return true;
  }
  const hadDigits = digits !== '';
  digits = '';
  const action = ACTIONS[ALIASES[name] ?? name];
  return action ? action() || hadDigits : hadDigits;
}

function statusText(): string {
  if (error !== '') return `\u001B[31m${error}\u001B[39m`;
  if (!doc) return status === '' ? 'no document — press o to open a PDF' : status;
  const mode = fit === 'page' ? 'fit page' : 'fit width';
  let text = `\u001B[1m${doc.title}\u001B[22m  ${page}/${doc.pages}  ${mode}`;
  if (invert) text += '  inverted';
  if (digits !== '') text += `  go to: ${digits}`;
  if (status !== '') text += `  ${status}`;
  return text;
}

function statusLine(cols: number): string {
  if (opening) return pathInput.render({width: cols, height: 1});
  const left = statusText();
  const hint = 'j/k scroll  n/p page  f fit  i invert  o open  q quit';
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

function drawPage(current: Doc, rows: number, cols: number): string {
  const area = Math.max(1, rows - 1);
  const box = layout(current, page, area, cols);
  scroll = fit === 'width' ? Math.min(scroll, Math.max(0, box.h - area)) : 0;
  const key = rasterKey(page, box);
  const raster = cache.get(key);
  if (!raster) {
    if (requested !== key) {
      requested = key;
      background(rasterize(current, page, box).then(() => {
        z.requestRender();
      }));
    }
    return placeholder(`rendering page ${page}…`, area, cols);
  }
  prefetch(current, area, cols);

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
    await z.waitForPermissions(['RunCommands']);
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
      return handleKey(z.keyName(event.Key.bare_key), event.Key.key_modifiers.includes('Ctrl'));
    }
    if ('Mouse' in event) {
      if ('ScrollDown' in event.Mouse) return scrollBy(step(3));
      if ('ScrollUp' in event.Mouse) return scrollBy(-step(3));
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
    const body = doc ? drawPage(doc, rows, cols) : '\n'.repeat(Math.max(0, rows - 1));
    return body + statusLine(cols);
  },
});
