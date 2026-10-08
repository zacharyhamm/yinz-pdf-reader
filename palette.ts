// Command palette entry for the PDF reader -- "Open PDF…" picks a PDF from the
// focused pane's git project, its main checkout and every worktree, with the
// builtin file finder (fzf in an overlay), and opens it in the reader.
//
// Load it in the background, so the action is there in every session:
//   load_plugins { "file:///path/to/yinz-pdf-reader/palette.ts" { shared true; }; }
import z, {definePlugin, type Action, type PaletteAction} from 'yinz:plugin';

export const READER = import.meta.resolve('./main.ts');

/**
 * Every PDF git tracks or would track (untracked but not ignored) in each
 * checkout of the repository the finder starts in, skipping a bare repository
 * and worktrees whose directory is gone, and files deleted from the working
 * tree. Outside a checkout, the PDFs under the directory, hidden ones left
 * out. Paths are absolute, as the reader does not open in the finder's
 * directory, and are joined with printf so no character in them is special.
 * git's errors would draw over fzf, so they are dropped.
 */
export const LIST = [
  `if git rev-parse --git-dir >/dev/null 2>&1; then`,
  `  git worktree list --porcelain 2>/dev/null |`,
  `  awk '/^worktree /{w=substr($0,10)} /^(bare|prunable)/{w=""} /^$/{if(w!="")print w; w=""} END{if(w!="")print w}' |`,
  `  while IFS= read -r w; do`,
  `    git -C "$w" -c core.quotePath=false ls-files -co --exclude-standard -- ':(icase)*.pdf' 2>/dev/null |`,
  `    while IFS= read -r f; do [ -f "$w/$f" ] && printf '%s/%s\\n' "$w" "$f"; done`,
  `  done`,
  `else`,
  `  find "$PWD" -mindepth 1 -name '.*' -prune -o -type f -iname '*.pdf' -print`,
  `fi`,
].join('\n');

/**
 * Launch the finder through the user's `file-finder` alias, so its geometry
 * and other settings apply, with this plugin's listing and opener on top.
 * `overlay` is read by the host, not the finder, and matches the default
 * keybinding's launch.
 */
export function finderLaunch(): Action {
  return {
    LaunchOrFocusPlugin: {
      plugin: {
        Alias: {
          name: 'file-finder',
          configuration: {overlay: 'true', file_command: LIST, openers_json: JSON.stringify({pdf: {plugin: READER, message: 'open'}})},
          initial_cwd: null,
          run_plugin: null,
        },
      },
      should_float: true,
      move_to_focused_tab: true,
      should_open_in_place: false,
      close_replaced_pane: false,
      skip_cache: false,
      tab_id: null,
    },
  };
}

const OPEN_PDF: PaletteAction = {
  id: 'open',
  label: 'Open PDF…',
  aliases: ['pdf reader', 'open document', 'pdf open', 'read pdf'],
  description: 'Find a PDF in this project or its worktrees',
  run: () => {
    z.command('RunAction', [finderLaunch(), {}]);
  },
};

export default definePlugin({
  defaults: {},
  async load() {
    await z.waitForPermissions(['ReadApplicationState', 'RunActionsAsUser']);
    z.commandPalette.registerProvider({
      id: 'pdf-reader',
      title: 'PDF reader',
      actions: [OPEN_PDF],
    });
  },
});
