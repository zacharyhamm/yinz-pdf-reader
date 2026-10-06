import {assert, session, test} from 'yinz:testing';

/** A minimal, valid, pure-ASCII PDF: `pages` letter pages, each labelled "Page n". */
function samplePdf(pages: number): string {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
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

function sample(): string {
  return `${session.fixture({'sample.pdf': samplePdf(50)})}/sample.pdf`;
}

test('pages through a document without stalling', {grants: ['RunCommands']}, async () => {
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

test('fit width scrolls within a page and spills to the next', {grants: ['RunCommands']}, async () => {
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

test('reports a missing file in the status line', {grants: ['RunCommands']}, async () => {
  session.start({rows: 20, columns: 100});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file: '/nonexistent/nope.pdf'}});
  await session.waitForText('nope.pdf');
});

test('opens a percent-encoded path containing a comma', {grants: ['RunCommands']}, async () => {
  const home = session.fixture({'Pachev, Sasha.pdf': samplePdf(3)});
  session.start({rows: 20, columns: 100});
  await session.waitForText('yinz-test>');
  session.loadPlugin('./main.ts', {configuration: {file: `${home}/Pachev%2C%20Sasha.pdf`}});
  await session.waitForText('1/3');
});

test('explains a path that `-c` split at a comma', {grants: ['RunCommands']}, async () => {
  const home = session.fixture({'Pachev, Sasha.pdf': samplePdf(3)});
  session.start({rows: 20, columns: 120});
  await session.waitForText('yinz-test>');
  // What `yinz plugin -c "file=$HOME/Pachev, Sasha.pdf"` delivers.
  session.loadPlugin('./main.ts', {configuration: {file: `${home}/Pachev`, ' Sasha.pdf': ''}});
  await session.waitForText('contains a comma');
});

test('searches forward through matches with smart case', {grants: ['RunCommands']}, async () => {
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

test('Esc ends a search and n pages again', {grants: ['RunCommands']}, async () => {
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

test('search lands on the match in fit width', {grants: ['RunCommands']}, async () => {
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
