# yinz-pdf-reader

A [yinz](https://github.com/zacharyhamm/yinz) TypeScript plugin that renders PDF
pages inside a pane with the kitty graphics protocol. Pages are drawn through
unicode placeholders, so the image lives in the pane's cell grid and clips,
scrolls, moves and resizes with the pane.

Requires a kitty-graphics terminal (kitty, Ghostty, WezTerm, …) and `pdfinfo`
plus `mutool` (MuPDF) or `pdftoppm` (Poppler) on the host. Search uses
`pdftotext` (Poppler, alongside `pdfinfo`); highlighting matches on the page
needs `mutool`, as do the table of contents and printed page labels.

The plugin asks for `RunCommands`, to run those tools, and `PluginData`, to
remember where each document was left.

## Opening a document

```sh
yinz plugin --floating \
  --configuration-json '{"file":"/books/Pachev, Sasha #?%2C 雪.pdf"}' \
  -- 'file:///path/to/yinz-pdf-reader/main.ts'
yinz pipe --plugin 'file:///path/to/yinz-pdf-reader/main.ts' --name open -- /path/to/doc.pdf
```

Or press `o` in the pane and type a path. Relative paths resolve against the
pane's working directory and `~/` against `$HOME`. Typed input trims surrounding
whitespace; JSON configuration and messages preserve it.

Document paths are literal: commas, spaces, and percent sequences need no
encoding in JSON configuration, messages, or typed opening. Plugin locations
are escaped URLs; escape spaces, `#`, `?`, `%`, and other special characters.

Rewrite previously encoded `file` settings once: `Pachev%2C%20Sasha.pdf` becomes
`Pachev, Sasha.pdf`. There is no automatic decoding or existence-based fallback:
a real `%2C` filename remains distinct from a comma filename. Saved positions
need no migration because their keys already use resolved document paths.

## From the command palette

`palette.ts` adds **Open PDF…** to the command palette (`Ctrl Alt p`). It opens
the builtin file finder (fzf, so `fzf` must be on `PATH`) listing every PDF in
the focused pane's git project: the main checkout and each of its worktrees,
tracked or untracked but not ignored. Outside a checkout it lists the PDFs
under the pane's directory, excluding hidden directories and files. Extensions
are case-insensitive; deleted and ignored files are excluded in git checkouts.
The finder supports UTF-8 filenames without newlines. The chosen file opens in
a floating reader pane. Later picks open in that same reader while it is running. The finder launches
through your `file-finder` alias, so its geometry and custom `fzf_args` apply.
The PDF launch overrides only `overlay`, `file_command`, and `openers_json`.
Configuration merges replace whole values, including the opener map. Persistent
alias settings stay unchanged. The finder sends the literal path directly to
the reader; manual `yinz pipe --name open` remains supported.

Find the action with “pdf reader”, “open document”, “pdf open”, or “read pdf”.
Native palette matching and ranking determine the results. Opens wait for
permissions and tool initialization, then run in arrival order. Individual open
failures do not stop later selections. Initialization failure or permission
denial requires reloading the plugin to retry. Sequential selections reuse the
reader; simultaneous independent finders can still launch separate readers.

Load it in the background in your yinz configuration:

```kdl
load_plugins {
    "file:///path/to/yinz-pdf-reader/palette.ts" {
        shared true
    }
}
```

`shared true` exposes the provider to every client in the session. Escape
special characters in the plugin URL. No manifest or autoload system is needed.

It asks for `ReadApplicationState` to register the action and `RunActionsAsUser`
to open the finder. A cold reader displays its permission prompt before opening
the selected PDF. The finder retires whether permission is granted or denied.

## Keys

| Key | Action |
| --- | --- |
| `j` `k` / `↓` `↑` / wheel | scroll (fit width) or next/previous page (fit page) |
| `d` `u` | half-screen scroll |
| `n` `Space` `PgDn` `l` `→` | next page |
| `p` `Backspace` `PgUp` `h` `←` | previous page |
| `g` `Home` / `G` `End` | first / last page |
| *number* `Enter` | go to page: the printed page label if the PDF has labels, else the PDF page |
| `t` | table of contents |
| `f` / `w` | toggle fit page / fit width |
| `i` | invert colours (mutool only) |
| `r` | reload the document |
| `o` | open another file |
| `/` | search |
| `n` / `N` | next / previous match while searching |
| `Esc` | clear the search, or close when none is active |
| `q` | close |

## Table of contents and page labels

`t` lists the document's outline, indented by level, with each entry's printed
page on the right, starting on the section you are in. `j`/`k`, the arrows,
`d`/`u`, `PgUp`/`PgDn`, `g`/`G` and the wheel move; `Enter` jumps there and
`Esc`, `q` or `t` closes the list. Entries that point at no page are shown
dimmed and skipped.

When a PDF labels its pages (front matter in roman numerals, say, so that
printed page 2 is the 22nd page), the status line shows both, `p. 2  22/256`,
and typing a number goes to that printed page. If the numbering restarts (an
appendix starting again at 1), it goes to the next page with that label after
the current one, so typing the number again steps through them; a number no
page carries is reported rather than taken as a PDF page.

## Reopening where you left off

The page, scroll position, fit mode and inversion are saved for each file and
restored when it is opened again. `r` reloads in place.

## Searching

Press `/`, type a query and press Enter. The document's text is extracted in
the background when it opens, so searching is instant; the reader jumps to the
first match on or after the current page and shows `match 3/61 · page 22` in
the status line. Matches are highlighted on the page, the current one in
orange, and in fit-width mode the view scrolls to keep it on screen.

Case is ignored unless the query contains an uppercase letter, and spaces in
the query match any run of whitespace, including line breaks. While a search
is active `n` and `N` step through matches (wrapping at either end) and
`Space`, `PgDn`, `p`, the arrows and so on still page.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `file` | – | document to open on load |
| `fit` | `page` | initial mode, `page` or `width` |
| `invert` | `false` | start with inverted colours |
| `cell_width`, `cell_height` | `12`, `22` | assumed cell size in pixels, used to shape the page box |
| `density` | `2` | rasterisation scale relative to the assumed cell size |

## Tests

```sh
/home/zacharyhamm/.local/bin/yinz plugins check --file main.ts --json
/home/zacharyhamm/.local/bin/yinz plugins check --file palette.ts --json
/home/zacharyhamm/.local/bin/yinz plugins test --file main.ts --kind all --timeout-ms 60000 --json
/home/zacharyhamm/.local/bin/yinz plugins test --file palette.ts --kind all --timeout-ms 60000 --json
```

Use the current installed binary: an older `yinz` on `PATH` can report the same
version while lacking the palette and testing APIs used here.

Unit tests cover static palette handles, structured opener configuration,
permission/tool readiness, FIFO opening, and failure recovery. Integration tests
use real disposable sessions, PDF tools, palette input, and fzf. They cover
paging, search, outlines, saved positions, literal filenames, escaped plugin
URLs, git worktrees, permission prompts, cancellation, and reader reuse.
