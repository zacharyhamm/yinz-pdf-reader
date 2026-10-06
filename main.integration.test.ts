import {assert, assertEquals, session, test, type TestOptions} from 'yinz:testing';

/**
 * A minimal, valid, pure-ASCII PDF: `pages` letter pages, each labelled "Page n".
 * With `extras`, the first two pages are labelled i and ii and the rest 1, 2, …,
 * and the outline has "Front matter" on page 1 and "Chapter n" on page 10n
 * (page 30 is printed page 28), with "Section 2.1" under "Chapter 2" on page 25.
 */
function samplePdf(pages: number, extras = false): string {
  const outlineFirst = 4 + pages * 2;
  const extrasDict = extras
    ? ` /PageLabels << /Nums [0 << /S /r >> 2 << /S /D >>] >> /Outlines ${outlineFirst} 0 R`
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
    // Outline root, then Front matter, Chapter 1..3, and Section 2.1.
    const root = outlineFirst;
    const ref = (n: number): string => `${4 + (n - 1) * 2} 0 R`;
    const top = [root + 1, root + 2, root + 3, root + 4];
    const titles = ['Front matter', 'Chapter 1', 'Chapter 2', 'Chapter 3'];
    const targets = [1, 10, 20, 30];
    objects.push(`<< /Type /Outlines /First ${top[0]} 0 R /Last ${top[3]} 0 R /Count 5 >>`);
    top.forEach((id, i) => {
      const prev = i > 0 ? ` /Prev ${id - 1} 0 R` : '';
      const next = i < top.length - 1 ? ` /Next ${id + 1} 0 R` : '';
      const kids = i === 2 ? ` /First ${root + 5} 0 R /Last ${root + 5} 0 R /Count 1` : '';
      objects.push(`<< /Title (${titles[i]}) /Parent ${root} 0 R${prev}${next}${kids} /Dest [${ref(targets[i] ?? 1)} /Fit] >>`);
    });
    objects.push(`<< /Title (Section 2.1) /Parent ${top[2]} 0 R /Dest [${ref(25)} /Fit] >>`);
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

test('opens a percent-encoded path containing a comma', GRANTS, async () => {
  const home = session.fixture({'Pachev, Sasha.pdf': samplePdf(3)});
  session.start({rows: 20, columns: 100});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file: `${home}/Pachev%2C%20Sasha.pdf`}});
  await session.waitForText('1/3');
});

test('explains a path that `-c` split at a comma', GRANTS, async () => {
  const home = session.fixture({'Pachev, Sasha.pdf': samplePdf(3)});
  session.start({rows: 20, columns: 120});
  await session.waitForText('yinz-test>');
  // What `yinz plugin -c "file=$HOME/Pachev, Sasha.pdf"` delivers.
  session.loadPlugin('./main.ts', {configuration: {file: `${home}/Pachev`, ' Sasha.pdf': ''}});
  await session.waitForText('contains a comma');
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
  await session.waitForText('contents  3/5');
  await session.waitForText('Section 2.1');
  session.key('j');
  await session.waitForText('contents  4/5');
  session.key('Enter');
  await session.waitForText('p. 23  25/50');
  session.key('t');
  await session.waitForText('contents  4/5');
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
  const rows = session.data(entity.owner_plugin, 'position');
  const column = (name: string): unknown => rows.rows[0]?.[rows.columns.indexOf(name)];
  assertEquals(rows.rows.length, 1);
  assertEquals(column('page'), {Int: 17});
  assertEquals(column('fit'), {Text: 'width'});
  session.reload('./main.ts');
  await session.waitForText('17/50  fit width');
});
