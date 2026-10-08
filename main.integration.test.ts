import {assert, assertEquals, session, test, type TestOptions} from 'yinz:testing';

/**
 * A minimal, valid, pure-ASCII PDF: `pages` letter pages, each labelled "Page n".
 * With `extras`, pages 1–2 are labelled i and ii, pages 3–40 1 to 38 and pages
 * 41–50, an appendix whose numbering restarts, 1 to 10. The outline has "Front
 * matter" on page 1, "Chapter n" on page 10n (page 30 is printed page 28) and
 * then, out of page order, "Index" on page 5. "Section 2.1" under "Chapter 2"
 * is on page 25, and "Missing" under "Chapter 3" points at no page.
 */
function samplePdf(pages: number, extras = false): string {
  const outlineFirst = 4 + pages * 2;
  const extrasDict = extras
    ? ` /PageLabels << /Nums [0 << /S /r >> 2 << /S /D >> 40 << /S /D >>] >> /Outlines ${outlineFirst} 0 R`
    : '';
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R${extrasDict} >>`,
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({length: pages}, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let i = 1; i <= pages; i += 1) {
    const stream = `BT /F1 48 Tf 72 680 Td (Page ${i}) Tj ET 0 0 1 rg 72 72 468 ${i * 10} re f`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (i - 1) * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  if (extras) {
    // Outline root, the top-level entries, then Section 2.1 and Missing.
    const root = outlineFirst;
    const ref = (n: number): string => `${4 + (n - 1) * 2} 0 R`;
    const titles = ['Front matter', 'Chapter 1', 'Chapter 2', 'Chapter 3', 'Index'];
    const targets = [1, 10, 20, 30, 5];
    const top = titles.map((_, i) => root + 1 + i);
    const child: Record<number, number> = {2: root + 6, 3: root + 7};
    objects.push(`<< /Type /Outlines /First ${top[0]} 0 R /Last ${top.at(-1)} 0 R /Count 7 >>`);
    top.forEach((id, i) => {
      const prev = i > 0 ? ` /Prev ${id - 1} 0 R` : '';
      const next = i < top.length - 1 ? ` /Next ${id + 1} 0 R` : '';
      const kid = child[i];
      const kids = kid === undefined ? '' : ` /First ${kid} 0 R /Last ${kid} 0 R /Count 1`;
      objects.push(`<< /Title (${titles[i]}) /Parent ${root} 0 R${prev}${next}${kids} /Dest [${ref(targets[i] ?? 1)} /Fit] >>`);
    });
    objects.push(
      `<< /Title (Section 2.1) /Parent ${top[2]} 0 R /Dest [${ref(25)} /Fit] >>`,
      `<< /Title (Missing) /Parent ${top[3]} 0 R /Dest (nowhere) >>`,
    );
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return `${out}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

function sample(extras = false): string {
  return `${session.fixture({'sample.pdf': samplePdf(50, extras)})}/sample.pdf`;
}

const GRANTS: TestOptions = {grants: ['RunCommands', 'PluginData']};

test('pages through a document without stalling', GRANTS, async () => {
  const file = sample();
  session.start({rows: 40, columns: 100});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file}});
  await session.waitForText('1/50');
  for (let page = 2; page <= 40; page += 1) {
    session.key('n');
    await session.waitForText(`${page}/50`, 5000);
  }
  session.key('G');
  await session.waitForText('50/50');
  session.key('g');
  await session.waitForText('1/50');
  session.text('25');
  session.key('Enter');
  await session.waitForText('25/50');
  assert(!session.logs.includes('Error'), session.logs);
});

test('fit width scrolls within a page and spills to the next', GRANTS, async () => {
  const file = sample();
  session.start({rows: 30, columns: 100});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file, fit: 'width'}});
  await session.waitForText('1/50  fit width');
  // A half-screen jump must stop at the bottom of the page before spilling.
  session.key('d');
  session.key('d');
  session.key('d');
  await session.waitForText('1/50  fit width');
  for (let i = 0; i < 40; i += 1) session.key('j');
  await session.waitForText('2/50  fit width');
  session.key('f');
  await session.waitForText('fit page');
});

test('reports a missing file in the status line', GRANTS, async () => {
  session.start({rows: 20, columns: 100});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file: '/nonexistent/nope.pdf'}});
  await session.waitForText('nope.pdf');
});

test('configuration and messages preserve literal paths with decoded-name decoys', GRANTS, async () => {
  const names = ['Pachev, Sasha #? 雪.pdf', '%2C.pdf', '%20.pdf', '%23.pdf', '%25.pdf', '%ZZ.pdf'];
  const files: Record<string, string> = {};
  for (const [i, name] of names.entries()) {
    files[name] = samplePdf(i + 2);
    if (name !== '%ZZ.pdf') files[decodeURIComponent(name)] ??= samplePdf(20);
  }
  const home = session.fixture(files);
  session.start({rows: 20, columns: 140});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file: `${home}/${names[0]}`}});
  await session.waitForText('1/2');
  for (const [i, name] of names.entries()) {
    session.pipe('open', `${home}/${name}`);
    await session.waitForText(`1/${i + 2}  fit page`);
    await session.waitFor('literal persisted path', () => JSON.stringify(session.data(import.meta.resolve('./main.ts'), 'position')).includes(`${home}/${name}`));
  }
});

test('searches forward through matches with smart case', GRANTS, async () => {
  const file = sample();
  session.start({rows: 40, columns: 120});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file}});
  await session.waitForText('1/50');
  // "Page 4" and "Page 40" to "Page 49".
  session.key('/');
  session.text('Page 4');
  session.key('Enter');
  await session.waitForText('match 1/11 · page 4');
  session.key('n');
  await session.waitForText('match 2/11 · page 40');
  session.key('N');
  await session.waitForText('match 1/11 · page 4');
  session.key('N');
  await session.waitForText('match 11/11 · page 49');
  await session.waitForText('search wrapped');
  session.key('/');
  // Lowercase ignores case; the search starts from the current page, 49.
  session.text('page 4');
  session.key('Enter');
  await session.waitForText('match 11/11 · page 49');
  session.key('/');
  session.text('PAGE 4');
  session.key('Enter');
  await session.waitForText('no matches for "PAGE 4"');
  assert(!session.logs.includes('Error'), session.logs);
});

test('Esc ends a search and n pages again', GRANTS, async () => {
  const file = sample();
  session.start({rows: 40, columns: 120});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file}});
  await session.waitForText('1/50');
  session.key('/');
  session.text('Page 7');
  session.key('Enter');
  await session.waitForText('match 1/1 · page 7');
  // Space still pages while a search is active.
  session.key('Space');
  await session.waitForText('8/50');
  session.key('n');
  await session.waitForText('7/50');
  session.key('Esc');
  session.key('n');
  await session.waitForText('8/50');
});

test('search lands on the match in fit width', GRANTS, async () => {
  const file = sample();
  session.start({rows: 30, columns: 100});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file, fit: 'width'}});
  await session.waitForText('1/50  fit width');
  session.key('/');
  session.text('Page 12');
  session.key('Enter');
  await session.waitForText('12/50  fit width  match 1/1 · page 12');
  assert(!session.logs.includes('Error'), session.logs);
});

test('the table of contents jumps to a section', GRANTS, async () => {
  const file = sample(true);
  session.start({rows: 40, columns: 120});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file}});
  await session.waitForText('1/50');
  // Printed page 20 is page 22.
  session.text('20');
  session.key('Enter');
  await session.waitForText('p. 20  22/50');
  // Opens on the section containing page 22, Chapter 2.
  session.key('t');
  await session.waitForText('contents  3/7');
  await session.waitForText('Section 2.1');
  session.key('j');
  await session.waitForText('contents  4/7');
  session.key('Enter');
  await session.waitForText('p. 23  25/50');
  session.key('t');
  await session.waitForText('contents  4/7');
  session.key('Esc');
  await session.waitForText('p. 23  25/50');
});

test('goes to a printed page label', GRANTS, async () => {
  const file = sample(true);
  session.start({rows: 40, columns: 120});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file}});
  await session.waitForText('p. i  1/50');
  session.text('28');
  session.key('Enter');
  await session.waitForText('p. 28  30/50');
});

test('says when a document has no table of contents', GRANTS, async () => {
  const file = sample();
  session.start({rows: 40, columns: 120});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file}});
  await session.waitForText('1/50');
  session.key('t');
  await session.waitForText('no table of contents');
});

test('reopens a document where it was left', GRANTS, async () => {
  const file = sample();
  session.start({rows: 40, columns: 120});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file}});
  await session.waitForText('1/50');
  session.text('17');
  session.key('Enter');
  session.key('f');
  await session.waitForText('17/50  fit width');
  const entity = session.catalog().find(info => info.def.name === 'position');
  assert(entity, JSON.stringify(session.catalog()));
  const rows = session.data(import.meta.resolve('./main.ts'), 'position');
  const column = (name: string): unknown => rows.rows[0]?.[rows.columns.indexOf(name)];
  assertEquals(rows.rows.length, 1);
  assertEquals(column('page'), {Int: 17});
  assertEquals(column('fit'), {Text: 'width'});
  session.reload('./main.ts');
  await session.waitForText('17/50  fit width');
});

test('the table of contents copes with an outline out of page order', GRANTS, async () => {
  const file = sample(true);
  session.start({rows: 40, columns: 120});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file}});
  await session.waitForText('1/50');
  session.key('G');
  await session.waitForText('50/50');
  // Chapter 3, not Index (page 5), which comes after it in the outline.
  session.key('t');
  await session.waitForText('contents  5/7');
  // Missing, which has no page, is listed but skipped.
  await session.waitForText('Missing');
  session.key('j');
  await session.waitForText('contents  7/7');
  session.key('k');
  await session.waitForText('contents  5/7');
  session.key('Enter');
  await session.waitForText('p. 28  30/50');
});

test('steps through restarted page numbers and refuses unknown ones', GRANTS, async () => {
  const file = sample(true);
  session.start({rows: 40, columns: 120});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file}});
  await session.waitForText('p. i  1/50');
  session.text('5');
  session.key('Enter');
  await session.waitForText('p. 5  7/50');
  // The appendix restarts at 1, so printed page 5 appears again on page 45.
  session.text('5');
  session.key('Enter');
  await session.waitForText('p. 5  45/50');
  session.text('5');
  session.key('Enter');
  await session.waitForText('p. 5  7/50');
  // No page is labelled 49, so stay put rather than go to page 49.
  session.text('49');
  session.key('Enter');
  await session.waitForText('no page labelled 49');
  await session.waitForText('p. 5  7/50');
});

const PALETTE_GRANTS: TestOptions = {grants: ['RunCommands', 'PluginData', 'ReadApplicationState', 'RunActionsAsUser']};
const CLI = '/home/zacharyhamm/.local/bin/yinz --session plugin-test';
const cliSocket = 'mkdir -p "$YINZ_SOCKET_DIR/cv1"; ln -sf "$HOME/../session" "$YINZ_SOCKET_DIR/cv1/plugin-test"';
const quote = (s: string): string => `'${s.replace(/'/gu, "'\\''")}'`;

async function paletteFinder(query = 'pdf open'): Promise<void> {
  session.key('Ctrl Alt p');
  session.text(query);
  await session.waitForText('Open PDF…');
  if (!session.screen.split('\n').some(line => line.includes('›') && line.includes('Open PDF…'))) {
    session.key('Up');
    await session.waitFor('PDF action selected', () => session.screen.split('\n').some(line => line.includes('›') && line.includes('Open PDF…')));
  }
  session.key('Enter');
  await session.waitFor('real fzf pane', () => session.panes.some(p => !p.is_plugin && p.terminal_command?.includes('fzf')));
}
function finders() {
  return session.panes.filter(p => !p.is_plugin && p.terminal_command?.includes('fzf'));
}
function readers(target = import.meta.resolve('./main.ts')) {
  return session.panes.filter(p => p.is_plugin && p.plugin_url && p.plugin_url.replace(/^file:\/*/u, '/') === decodeURIComponent(target.replace(/^file:\/*/u, '/')));
}
/** The host permission modal starts on Deny: Tab moves to Allow, Esc denies. */
function answerPermissions(allow: boolean): void {
  if (allow) {
    session.key('Tab');
    session.key('Enter');
  } else {
    session.key('Esc');
  }
}
async function choose(name: string, pages: number, cold = false): Promise<void> {
  await session.waitForText(name);
  session.text(name);
  await session.waitFor('one fzf match', () => /\b1\/\d+\b/u.test(session.screen));
  session.key('Enter');
  if (cold) {
    await session.waitForText('Plugin permissions');
    assertEquals(finders().length, 0);
    answerPermissions(true);
  }
  await session.waitFor('PDF raster displayed', () => session.screen.includes(`1/${pages}  fit page`) && !session.screen.includes('rendering page'));
  await session.waitFor('finder retired', () => finders().length === 0);
}

test('real palette aliases, non-git finder, cancellation and warm reader reuse across tabs', PALETTE_GRANTS, async () => {
  const home = session.fixture({
    'first, #?雪%2C%20%23%25%ZZ.pdf': samplePdf(3), 'second%20.PDF': samplePdf(4),
    'second .PDF': samplePdf(9), '.hidden/secret.pdf': samplePdf(8),
  });
  session.start({rows: 35, columns: 160, backgroundPlugins: ['./palette.ts']});
  await session.waitForText('yinz-test>');
  // Registration is asynchronous: opening the palette waits for its inventory.
  await paletteFinder('pdf reader');
  await session.waitForText('first, #?雪%2C%20%23%25%ZZ.pdf');
  assert(!session.screen.includes('secret.pdf'));
  session.key('Esc');
  await session.waitFor('finder cancelled', () => finders().length === 0);
  assertEquals(readers().length, 0);
  await paletteFinder('open document');
  await choose('first, #?雪%2C%20%23%25%ZZ.pdf', 3, true);
  const reader = readers()[0];
  assert(reader?.is_floating && reader.is_focused);
  session.action('ToggleFloatingPanes');
  await session.waitFor('reader hidden', () => !session.screen.includes('fit page'));
  await paletteFinder('read pdf');
  await choose('second%20.PDF', 4);
  assertEquals(readers().map(p => p.id), [reader.id]);
  assert(readers()[0]?.is_focused);
  session.action('ToggleFloatingPanes');
  await session.waitFor('reader hidden before cancelling finder', () => !session.screen.includes('fit page'));
  await paletteFinder('open document');
  await session.waitForText('first, #?雪%2C%20%23%25%ZZ.pdf');
  session.key('Esc');
  await session.waitFor('warm finder cancelled', () => finders().length === 0);
  session.action('ToggleFloatingPanes');
  await session.waitForText('1/4  fit page');
  assertEquals(readers().map(p => p.id), [reader.id]);
  session.action('NewTab');
  await session.waitForText('yinz-test>');
  session.text('cd "$HOME"');
  session.key('Enter');
  await session.waitFor('new tab cwd', () => session.panes.some(p => p.is_focused && p.cwd === home));
  await paletteFinder();
  await choose('first, #?雪%2C%20%23%25%ZZ.pdf', 3);
  assertEquals(readers().map(p => p.id), [reader.id]);
  session.key('Ctrl Alt p');
  session.text('pdf reader');
  await session.waitForText('Open PDF…');
  session.key('Esc');
  await session.waitForText('1/3  fit page');
  assertEquals(finders().length, 0);
  const rows = session.data(import.meta.resolve('./main.ts'), 'position');
  assert(JSON.stringify(rows).includes(`${home}/second%20.PDF`));
});

test('cold reader denial is visible and retires the finder', PALETTE_GRANTS, async () => {
  session.fixture({'denied.pdf': samplePdf(2)});
  session.start({rows: 30, columns: 140, backgroundPlugins: ['./palette.ts']});
  await session.waitForText('yinz-test>');
  await paletteFinder();
  await session.waitForText('denied.pdf');
  session.text('denied.pdf');
  session.key('Enter');
  await session.waitForText('Plugin permissions');
  assertEquals(finders().length, 0);
  answerPermissions(false);
  await session.waitForText('plugin permissions denied');
  assertEquals(readers().length, 1);
  assert(!session.screen.includes('1/2  fit page'));
});

test('git main and linked worktrees from nested cwd preserve alias options', PALETTE_GRANTS, async () => {
  const home = session.fixture({
    'repo/tracked.pdf': samplePdf(2), 'repo/deleted.pdf': samplePdf(8),
    'repo/untracked.PDF': samplePdf(3), 'repo/ignored.pdf': samplePdf(9),
    'repo/.gitignore': 'ignored.pdf\n', 'repo/nested/keep': '',
    'alias.kdl': 'plugins { file-finder location="yinz:file-finder" { width "80%"; height "70%"; fzf_args "--prompt=custom-pdf: --no-sort"; }; }\n',
  }, {setup: `set -eu
${cliSocket}
cd "$HOME/repo"
git init -q
git add tracked.pdf deleted.pdf .gitignore
git -c user.name=Test -c user.email=test@example.invalid commit -qm initial
git worktree add -qb linked "$HOME/linked"
rm deleted.pdf "$HOME/linked/deleted.pdf"
cp untracked.PDF "$HOME/linked/linked.PDF"
${CLI} action reconfigure --file "$HOME/alias.kdl"
echo FIXTURE_READY`});
  session.start({rows: 40, columns: 160, backgroundPlugins: ['./palette.ts']});
  await session.waitForText('yinz-test>');
  session.text('setup && cd "$HOME/repo/nested"');
  session.key('Enter');
  await session.waitForText('FIXTURE_READY');
  await paletteFinder();
  await session.waitForText('custom-pdf:');
  await session.waitForText(`${home}/linked/linked.PDF`);
  assert(session.screen.includes(`${home}/repo/tracked.pdf`));
  assert(session.screen.includes(`${home}/repo/untracked.PDF`));
  assert(!session.screen.includes('ignored.pdf'));
  assert(!session.screen.includes('deleted.pdf'));
  const finder = finders()[0];
  assert(finder && finder.pane_columns >= 120 && finder.pane_rows >= 25);
  await choose('linked.PDF', 3, true);
});

test('JSON CLI preserves special document paths and escaped source URLs', PALETTE_GRANTS, async () => {
  const name = 'Pachev, Sasha #?雪%2C%20%23%25%ZZ.pdf';
  const sourceDir = 'source ,#?雪%2C%20%23%25%ZZ';
  const source = decodeURIComponent(import.meta.resolve('./main.ts').replace(/^file:\/\//u, ''));
  const home = session.fixture({[name]: samplePdf(5), 'Pachev, Sasha #?雪, #%%ZZ.pdf': samplePdf(9)}, {
    'copy-reader': `${cliSocket}
mkdir -p "$HOME/${sourceDir}"\ncp ${quote(source)} "$HOME/${sourceDir}/"`,
  });
  const target = `file://${home}/${encodeURIComponent(sourceDir)}/main.ts`;
  session.start({rows: 35, columns: 160});
  await session.waitForText('yinz-test>');
  session.text(`copy-reader && ${CLI} plugin --floating --configuration-json ${quote(JSON.stringify({file: `${home}/${name}`}))} -- ${quote(target)}`);
  session.key('Enter');
  await session.waitForText('Plugin permissions');
  answerPermissions(true);
  await session.waitForText('1/5  fit page');
  const id = readers(target)[0]?.id;
  assert(id !== undefined);
});

test('a reader alias configured on the palette receives the pick', PALETTE_GRANTS, async () => {
  const reader = import.meta.resolve('./main.ts');
  session.fixture({
    'aliased.pdf': samplePdf(6),
    'alias.kdl': `plugins { pdf-reader location=${JSON.stringify(reader)}; }\n`,
  }, {setup: `set -eu
${cliSocket}
${CLI} action reconfigure --file "$HOME/alias.kdl"
echo FIXTURE_READY`});
  session.start({rows: 35, columns: 160, backgroundPlugins: [{path: './palette.ts', configuration: {reader: 'pdf-reader'}}]});
  await session.waitForText('yinz-test>');
  session.text('setup');
  session.key('Enter');
  await session.waitForText('FIXTURE_READY');
  await paletteFinder();
  await choose('aliased.pdf', 6, true);
  // The pane carries the alias, not the file, so its identity survives updates.
  assertEquals(session.panes.filter(p => p.is_plugin && p.plugin_url === 'pdf-reader').length, 1);
  assertEquals(readers().length, 0);
});
