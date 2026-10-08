import {assert, assertEquals, loadPlugin, test, type PluginHarness} from 'yinz:testing';

const replies = {
  RequestPluginPermissions: null, RunCommand: null,
  GetPluginIds: {plugin_id: 1, client_id: 1, initial_cwd: '/tmp'},
  DataDefineEntity: {}, DataFetch: {columns: [], rows: [], truncated: false, next_cursor: null}, DataApply: {},
};
type Run = {RunCommand: [string[], unknown, string, Record<string, string>]};
function runs(plugin: PluginHarness): Run[] {
  return plugin.commands.filter((c): c is Run => typeof c === 'object' && c !== null && 'RunCommand' in c);
}
async function finish(plugin: PluginHarness, command: Run, stdout = '', exit = 0): Promise<void> {
  await plugin.event({RunCommandResult: [exit, Array.from(stdout, c => c.charCodeAt(0)), [], command.RunCommand[3]]});
}

test('queues configured and early literal messages behind permissions and tools, recovering after failure', async () => {
  const first = '/books/first%2C.pdf ';
  const second = '/books/雪 #?%20%23%25%ZZ.pdf';
  const plugin = await loadPlugin('./main.ts', {configuration: {file: first}, replies});
  await plugin.pipe({name: 'open', payload: '/missing.pdf'});
  await plugin.pipe({name: 'open', payload: second});
  await plugin.pipe({name: 'other', payload: '/ignored.pdf'});
  await plugin.pipe({name: 'open', payload: null});
  await plugin.pipe({name: 'open', payload: ''});
  assertEquals(runs(plugin).length, 0);
  await plugin.event({PermissionRequestResult: 'Granted'});
  assertEquals(runs(plugin).length, 1);
  await finish(plugin, runs(plugin)[0]!, '/home/test\n');
  assertEquals(runs(plugin).at(-1)!.RunCommand[0], ['pdfinfo', first]);
  await finish(plugin, runs(plugin).at(-1)!, 'Pages: 2\n');
  assertEquals(runs(plugin).at(-1)!.RunCommand[0], ['pdfinfo', '-f', '1', '-l', '2', first]);
  await finish(plugin, runs(plugin).at(-1)!);
  assertEquals(runs(plugin).at(-1)!.RunCommand[0], ['pdfinfo', '/missing.pdf']);
  await finish(plugin, runs(plugin).at(-1)!, '', 1);
  assertEquals(runs(plugin).at(-1)!.RunCommand[0], ['pdfinfo', second]);
  await finish(plugin, runs(plugin).at(-1)!, 'Pages: 3\n');
  await finish(plugin, runs(plugin).at(-1)!);
  assert((await plugin.render(20, 140)).includes('1/3'));
  assertEquals(runs(plugin).filter(c => c.RunCommand[0][0] === 'pdfinfo' && c.RunCommand[0].length === 2).map(c => c.RunCommand[0][1]), [first, '/missing.pdf', second]);
});

test('denial blocks current and future document commands until reload', async () => {
  const plugin = await loadPlugin('./main.ts', {configuration: {file: '/first.pdf'}, replies});
  await plugin.pipe({name: 'open', payload: '/second.pdf'});
  await plugin.event({PermissionRequestResult: 'Denied'});
  await plugin.pipe({name: 'open', payload: '/third.pdf'});
  assertEquals(runs(plugin).length, 0);
  assert((await plugin.render()).toLowerCase().includes('denied'));
});

test('waits for mutool setup and preserves relative paths after HOME discovery', async () => {
  const plugin = await loadPlugin('./main.ts', {replies});
  await plugin.event({PermissionRequestResult: 'Granted'});
  await plugin.pipe({name: 'open', payload: '~/book.pdf'});
  await finish(plugin, runs(plugin)[0]!, '/home/test\n/usr/bin/mutool\n');
  assertEquals(runs(plugin).length, 2);
  assertEquals(runs(plugin)[1]!.RunCommand[0][0], 'sh');
  await finish(plugin, runs(plugin)[1]!, '/tmp/scripts\n');
  assertEquals(runs(plugin).at(-1)!.RunCommand[0], ['pdfinfo', '/home/test/book.pdf']);
});

test('failed initialization blocks later requests', async () => {
  const plugin = await loadPlugin('./main.ts', {replies});
  await plugin.event({PermissionRequestResult: 'Granted'});
  await finish(plugin, runs(plugin)[0]!, '', 1);
  await plugin.pipe({name: 'open', payload: '/blocked.pdf'});
  assertEquals(runs(plugin).length, 1);
  assert((await plugin.render()).includes('could not detect PDF tools'));
});

test('typed opening and reload use the same serial queue', async () => {
  const plugin = await loadPlugin('./main.ts', {replies});
  const key = async (name: string) => {
    await plugin.event({Key: {bare_key: name === 'Enter' ? 'Enter' : {Char: name}, key_modifiers: []}});
  };
  await key('o');
  for (const char of ' /typed%2C.pdf ') await key(char);
  await key('Enter');
  assertEquals(runs(plugin).length, 0);
  await plugin.event({PermissionRequestResult: 'Granted'});
  await finish(plugin, runs(plugin)[0]!, '/home/test\n');
  assertEquals(runs(plugin).at(-1)!.RunCommand[0], ['pdfinfo', '/typed%2C.pdf']);
  await finish(plugin, runs(plugin).at(-1)!, 'Pages: 2\n');
  await finish(plugin, runs(plugin).at(-1)!);
  await key('r');
  await plugin.pipe({name: 'open', payload: '/next.pdf'});
  assertEquals(runs(plugin).at(-1)!.RunCommand[0], ['pdfinfo', '/typed%2C.pdf']);
  await finish(plugin, runs(plugin).at(-1)!, 'Pages: 2\n');
  await finish(plugin, runs(plugin).at(-1)!);
  assertEquals(runs(plugin).at(-1)!.RunCommand[0], ['pdfinfo', '/next.pdf']);
});
