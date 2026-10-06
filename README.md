# yinz-pdf-reader

A [yinz](https://github.com/zacharyhamm/yinz) TypeScript plugin that renders PDF
pages inside a pane with the kitty graphics protocol. Pages are drawn through
unicode placeholders, so the image lives in the pane's cell grid and clips,
scrolls, moves and resizes with the pane.

Requires a kitty-graphics terminal (kitty, Ghostty, WezTerm, …) and `pdfinfo`
plus `mutool` (MuPDF) or `pdftoppm` (Poppler) on the host. Search uses
`pdftotext` (Poppler, alongside `pdfinfo`); highlighting matches on the page
needs `mutool`.

## Opening a document

```sh
yinz plugin --floating -c file=/path/to/doc.pdf -- file:$PWD/main.ts
yinz pipe --plugin file:$PWD/main.ts --name open -- /path/to/doc.pdf
```

or press `o` in the pane and type a path. Relative paths resolve against the
pane's working directory and `~/` against `$HOME`.

`yinz plugin -c` splits its argument on every comma, so a path containing one
must be percent-encoded (`file=/books/Pachev%2C%20Sasha.pdf`); `file` is always
percent-decoded. Opening through `o` or `yinz pipe` needs no encoding.

## Keys

| Key | Action |
| --- | --- |
| `j` `k` / `↓` `↑` / wheel | scroll (fit width) or next/previous page (fit page) |
| `d` `u` | half-screen scroll |
| `n` `Space` `PgDn` `l` `→` | next page |
| `p` `Backspace` `PgUp` `h` `←` | previous page |
| `g` `Home` / `G` `End` | first / last page |
| *number* `Enter` | go to page |
| `f` / `w` | toggle fit page / fit width |
| `i` | invert colours (mutool only) |
| `r` | reload the document |
| `o` | open another file |
| `/` | search |
| `n` / `N` | next / previous match while searching |
| `Esc` | clear the search, or close when none is active |
| `q` | close |

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
yinz plugins test --file main.ts
```

The integration tests build a 50-page PDF in a disposable yinz session and page,
scroll, jump and search through it.
