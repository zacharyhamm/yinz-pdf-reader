# yinz-pdf-reader

A [yinz](https://github.com/zacharyhamm/yinz) Steel Scheme plugin that renders PDF
pages inside a pane with the kitty graphics protocol. Pages are drawn through
unicode placeholders, so the image lives in the pane's cell grid and clips,
scrolls, moves and resizes with the pane.

Requires a kitty-graphics terminal (kitty, Ghostty, WezTerm, …) and `pdfinfo`
plus `mutool` (MuPDF) or `pdftoppm` (Poppler) on the host. Search uses
`pdftotext` (Poppler, alongside `pdfinfo`); highlighting matches on the page
needs `mutool`, as do the table of contents and printed page labels.

Requires yinz `main` at **d9e8dbf7e3827ff22988e816219930fd610847d9** or newer. The version
string `0.1.0` alone does not identify this SDK: it must provide
`yinz-plugin-resolve`, `yinz-cell-pixel-size`, Unicode regex support, and the
8 MiB `yinz-ui-image-max-bytes` limit, and must no longer reuse client ids (that
build removed the `ClientGridReset` event). Earlier Steel builds are unsupported.

The plugin asks for `RunCommands`, to run those tools, and `PluginData`, to
remember where each document was left.

## Opening a document

```sh
yinz plugin --floating \
  --configuration-json '{"file":"/books/Pachev, Sasha #?%2C 雪.pdf"}' \
  -- 'file:///path/to/yinz-pdf-reader/main.scm'
yinz pipe --plugin 'file:///path/to/yinz-pdf-reader/main.scm' --name open -- /path/to/doc.pdf
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

`palette.scm` adds **Open PDF…** to the command palette (`Ctrl Alt p`). It opens
the builtin file finder (fzf, so `fzf` must be on `PATH`) listing every PDF in
the focused pane's git project: the main checkout and each of its worktrees,
tracked or untracked but not ignored. Outside a checkout it lists the PDFs
under the pane's directory, excluding hidden directories and files. Extensions
are case-insensitive; deleted and ignored files are excluded in git checkouts.
The finder supports UTF-8 filenames without newlines. The chosen file opens in
a tiled reader pane beside your panes. Later picks open in that same reader while it is
running, and focus it, from any tab. The finder launches
through your `file-finder` alias, so its geometry and custom `fzf_args` apply.
The PDF launch overrides only `overlay`, `file_command`, and `openers_json`.
Configuration merges replace whole values, including the opener map. Persistent
alias settings stay unchanged. The finder hands the literal path back to the
palette plugin, since a reader the finder launches itself would float; the
palette pipes it on to the reader as a tiled launch with a `focus` argument,
which a pipe to a running reader otherwise lacks. Manual `yinz pipe --name open`
remains supported and leaves focus where it is.

Find the action with “pdf reader”, “open document”, “pdf open”, or “read pdf”.

**Open PDF from folder…** (“pdf folder”, “pdf directory”, “browse pdfs”) works
in two steps. A first finder lists your home directory and every folder under
it, excluding hidden ones. Pick a folder and a second finder lists the PDFs
anywhere beneath it, again without hidden files or directories, and the pick
opens in the reader. Both finders send their pick back to the palette
plugin, which surfaces it briefly as a floating pane; the plugin hides itself
again before launching the second finder or the reader. Both finders use your `file-finder`
alias settings.
Native palette matching and ranking determine the results. Opens wait for
permissions and tool initialization, then run in arrival order. Individual open
failures do not stop later selections. Initialization failure or permission
denial requires reloading the plugin to retry. Sequential selections reuse the
reader; simultaneous independent finders can still launch separate readers.

Load it in the background in your yinz configuration:

```kdl
load_plugins {
    "file:///path/to/yinz-pdf-reader/palette.scm" {
        shared true
    }
}
```

`shared true` exposes the provider to every client in the session. Escape
special characters in the plugin URL. No manifest or autoload system is needed.

To install from GitHub instead of a local checkout, declare both entrypoints as
repository plugins and load the palette by alias. `reader` points picks at the
reader's alias, so permissions and saved positions follow it across updates:

```kdl
plugins {
    pdf-reader repo="https://github.com/zacharyhamm/yinz-pdf-reader.git" branch="main"
    pdf-palette repo="https://github.com/zacharyhamm/yinz-pdf-reader.git" branch="main" entrypoint="palette.scm" {
        shared true
        reader "pdf-reader"
    }
}
load_plugins {
    "pdf-palette"
}
```

`yinz plugins update pdf-reader pdf-palette` fetches new commits; reload the
running plugins to use them.

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
| `i` | invert colours (mutool only; without it the status line says so) |
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
restored when it is opened again. `r` reloads in place, keeping an active search
without jumping to its next match.

## Searching

Press `/`, type a query and press Enter. The document's text is extracted in
the background when it opens, so searching is instant; the reader jumps to the
first match on or after the current page and shows `match 3/61 · page 22` in
the status line. Matches are highlighted on the page, the current one in
orange, and in fit-width mode the view scrolls to keep it on screen.

Search ignores case using Unicode simple folding unless the query contains a
letter in Unicode category `Lu` (uppercase letters). Titlecase letters such as
`ǅ` keep matching case-insensitively. Simple folding matches `s` with `ſ`, but
does not expand `ß` to `ss`. Spaces in the query match any run of whitespace,
including line breaks. While a search is active `n` and `N` step through matches
(wrapping at either end) and `Space`, `PgDn`, `p`, the arrows and so on still page.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `file` | – | document to open on load |
| `fit` | `page` | initial mode, `page` or `width` |
| `invert` | `false` | start with inverted colours |
| `cell_width`, `cell_height` | terminal report, else `12`, `22` | explicit pixel dimensions override the terminal report |
| `density` | `1` with known cell pixels, else `2` | rasterisation scale relative to the cell size, lowered when a page would exceed the host's image limits |

## Tests

```sh
yinz plugins check ./main.scm --json
yinz plugins check ./palette.scm --json
yinz plugins test --file ./lib/text.scm --json
yinz plugins test --file ./main.scm --kind all --timeout-ms 120000 --json
yinz plugins test --file ./palette.scm --kind unit --json
```

Use the SDK build identified above. Put that binary first on `PATH`, so fixture
CLI commands use the same build as the test runner.

`lib/text.test.scm` covers PDF fields and geometry, `pdftotext -bbox` words,
and the Unicode smart-case matcher. Unit tests cover static palette handles,
structured opener configuration, confined sibling reader resolution, cell-pixel
reports and overrides, permission/tool readiness, FIFO opening, saved positions
and failure recovery. Integration tests use real
disposable sessions, PDF tools, palette input, and fzf. They cover paging,
search, outlines, saved positions, literal filenames, escaped plugin URLs, git
worktrees, permission prompts, cancellation, and reader reuse.

## Steel notes

The palette resolves its sibling `main.scm` through the host's confined source
resolver, including pinned Git repository installs. Set `reader` to a stable
alias to preserve reader identity across repository updates. Folder and PDF picks use
`plugin_id` so they reach the existing palette instance.

Cell-pixel reports update the raster dimensions and invalidate cached geometry.
Terminals without reports use the documented fallback, and explicit geometry
settings take precedence. Reported or configured cells are the terminal's own
pixels, so pages draw at density 1, one image pixel per terminal pixel; the
fallback geometry is a guess and draws at density 2. A configured `density`
overrides both. Density drops only when the raster would exceed the
host's image limits (10000 pixels a side, 100 MiB decoded), as a full-screen pane
with large cells can; that page is drawn at the largest scale that fits and
still fills its box. A PNG over the 8 MiB transfer limit, such as a scanned page
in a large pane, is drawn again smaller until it fits. Zero cell-pixel reports
count as unknown. A page that fails to render shows its error in place of the
page, without affecting other pages; a page mutool cannot draw is drawn with
pdftoppm instead, and a page whose search highlights fail is shown without them. Client ids are not reused, so a reattaching client is sent the page
image again without a grid-reset event.

The large-page regression uses `/usr/bin/python3` to generate a deterministic
noise PDF, and real MuPDF to verify its PNG exceeds 2 MiB at density 2. It checks
repeated navigation and a later `open` message against the same reader instance.

Integration fixtures use `test-resolve` and `test-copy-plugin`; only Scheme source
dependencies are copied. Runtime assets must be explicit fixtures. Fixture CLI
commands use the harness socket environment. Put the tested Yinz binary first on
`PATH` when running the suites.

Saved positions belong to the reader's identity, so positions saved by the old
`main.ts` reader are not seen by `main.scm`.
