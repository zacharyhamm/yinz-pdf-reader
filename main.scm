;; PDF reader -- renders PDF pages inside a yinz pane with the kitty graphics
;; protocol, using unicode placeholders so the image lives in the pane's cell
;; grid: it clips, scrolls and moves with the pane like ordinary text.
;;
;; Pages are rasterised with `mutool draw` (falling back to `pdftoppm`) and page
;; geometry comes from `pdfinfo`. Search runs over text `pdftotext` extracts in
;; the background when a document opens; matches are located with
;; `pdftotext -bbox` and painted onto the page by a small `mutool run` script.
;;
;; Open a file:
;;   yinz plugin --floating --configuration-json '{"file":"/path/to/doc.pdf"}' -- file:///path/to/main.scm
;;   yinz pipe --plugin file:///path/to/main.scm --name open -- /path/to/doc.pdf
;; or press `o` inside the pane and type a path.
;;
;; Keys: j/k ↓/↑ scroll (or page in fit-page mode), d/u half-screen scroll,
;; Space/PgDn/n/l next page, Backspace/PgUp/p/h previous page, g/G first/last,
;; <number>Enter go to page, f toggle fit page / fit width, i invert colours,
;; r reload, o open, q/Esc close. The mouse wheel scrolls. / searches; while a
;; search is active n/N go to the next/previous match and Esc clears it. t opens
;; the table of contents. <number>Enter goes to a printed page label when the
;; PDF has one, and each file reopens where it was left.
(require "./lib/text.scm")
(require "./lib/keys.scm")

(define LETTER (list 612 792))
(define CACHE-LIMIT 12)
(define ESC "\x1b;")

;; Reports set the raster scale; explicit configuration wins, with a fallback
;; for terminals that do not report cell pixels. Density remains two.
(define cell-width-px 12)
(define cell-height-px 22)
(define cell-width-override #f)
(define cell-height-override #f)
(define cell-geometries (hash))
(define density 2)

;; The open document: "path", "title", "pages", and "sizes", a vector of page
;; sizes in points already swapped for 90/270 rotation (index 0 is page 1).
;; "serial" tells one opening from the next.
(define doc #f)
(define doc-serial 0)
(define page 1)
(define fit "page")
(define invert #f)
;; Rows scrolled into the page in fit-width mode.
(define scroll 0)
(define status "")
(define failure "")
(define digits "")
(define opening #f)
(define searching #f)

(define path-input (yinz-ui-text-input "open: "))
(define search-input (yinz-ui-text-input "/"))
(define (input-replace! input text) (yinz-ui-text-input-op input "ReplaceText" (list text (string-length text))))

;; Each page's text with whitespace collapsed, or #f until indexed.
(define texts #f)
;; The active search: "id", "query", "matcher", "hits" (a vector of (page . k),
;; k counting occurrences on its page from 0) and "index".
(define search #f)
(define search-id 0)
;; A query submitted before the text was indexed.
(define queued "")
;; A one-off search message ("no matches", "wrapped"), cleared on the next key.
(define notice "")
;; Each page's occurrence rectangles for the active search, one rect per word.
(define boxes (hash))
(define boxes-pending (hash))
;; Scroll the current match into view once its page's boxes arrive.
(define reveal-pending #f)
;; The outline, a vector of "title" "depth" "page" hashes (page 0 resolves to
;; no page; those are listed but cannot be chosen), and printed page labels by
;; page (index 0 is page 1), or #f when they are just the page numbers.
(define outline (vector))
(define labels #f)
(define meta-ready #f)
;; Why there is no outline when the document might have one, or "".
(define meta-problem "")
(define contents #f)
(define toc-index 0)
(define toc-top 0)
;; The position last written to the data store, to skip unchanged writes.
(define saved "")
(define renderer "mutool")
(define home-dir "")
(define initial-cwd "")
;; Holds the mutool run scripts, written once at load and removed on unload.
(define scratch "")
(define last-rows 0)
(define last-cols 0)
(define requested "")

;; The host does not deduplicate transmissions, so remember which raster each
;; client last received and only transmit when that changes. Each new raster
;; gets a fresh image id (re-sending under an existing id would replace the
;; image and drop its placement); the previous one is deleted explicitly so
;; the host's image store stays small however far you page. Client ids are
;; never reused, so a reattaching client has no entry and gets the image anew.
(define next-id (+ 1 (yinz-random-integer (- yinz-ui-image-max-id 1000000))))
(define shown (hash))
;; Rasters by key, "key" and "png", oldest first in cache-order.
(define cache (hash))
(define cache-order '())
(define pending (hash))

;; ---------------------------------------------------------------------------
;; Small helpers: JavaScript's rounding and number printing, lookups, deferreds.

;; Math.round: halves go up. Scheme's round goes to even.
(define (js-round x) (exact (floor (+ (exact->inexact x) 0.5))))
(define (js-floor x) (exact (floor (exact->inexact x))))
(define (js-ceil x) (exact (ceiling (exact->inexact x))))
(define (sign x) (cond [(> x 0) 1] [(< x 0) -1] [else 0]))
;; String(n): integral values print without a fraction.
(define (num->string n)
  (if (and (number? n) (integer? n)) (number->string (exact n)) (number->string n)))
;; Number(text) || fallback, for configuration values.
(define (config-number configuration key fallback)
  (define value (and (hash-contains? configuration key) (string->number (trim (hash-ref configuration key)))))
  (if (and value (not (= value 0))) value fallback))
(define (get h key fallback) (if (and (hash? h) (hash-contains? h key)) (hash-ref h key) fallback))
(define (resolved value) (let ([d (yinz-deferred)]) (yinz-resolve! d value) d))
(define (message-of reason)
  (cond
    [(string? reason) reason]
    [else (with-handler (lambda (_) (value->string reason)) (error-object-message reason))]))
(define (index-where ok? v)
  (let loop ([i 0]) (cond [(>= i (vector-length v)) -1] [(ok? (vector-ref v i)) i] [else (loop (+ i 1))])))
(define (vector-some? ok? v) (>= (index-where ok? v) 0))
(define (vector-at v i fallback) (if (and v (>= i 0) (< i (vector-length v))) (vector-ref v i) fallback))
(define (repeat text n) (if (<= n 0) "" (string-append text (repeat text (- n 1)))))
(define (newlines n) (make-string (max 0 n) #\newline))
(define (text-width s) (yinz-ui-pure (hash "op" "Width" "args" s)))
(define (text-sanitize s) (yinz-ui-pure (hash "op" "Sanitize" "args" s)))
(define (doc-is? current) (and doc current (= (hash-ref doc "serial") (hash-ref current "serial"))))
(define (client-id) (hash-ref (yinz-command "GetPluginIds") "client_id"))

(define (background job)
  (yinz-catch job
    (lambda (reason)
      (set! failure (message-of reason))
      (yinz-request-render))))

(define (resolve-path path)
  (define p (if (starts-with? path "~/") (string-append home-dir (substring path 1 (string-length path))) path))
  (if (starts-with? p "/") p
    (string-append (if (ends-with? initial-cwd "/") (substring initial-cwd 0 (- (string-length initial-cwd) 1)) initial-cwd)
      "/" p)))

(define (run command)
  (yinz-then (yinz-run-command (hash "command" command "max-bytes" (* 64 1024 1024)))
    (lambda (result)
      (hash "ok" (equal? (hash-ref result "exit-code") 0)
            "stdout" (hash-ref result "stdout")
            "stderr" (trim (yinz-decode-utf8 (hash-ref result "stderr")))))))
(define (ok? result) (hash-ref result "ok"))
(define (stdout-text result) (yinz-decode-utf8 (hash-ref result "stdout")))
(define (stderr-text result) (hash-ref result "stderr"))

(define (fail message)
  (set! failure message)
  (set! status "")
  (yinz-request-render))

;; ---------------------------------------------------------------------------
;; Opening a document.

;; Per-page sizes and rotations, so mixed-size documents lay out correctly.
(define (page-sizes path pages)
  (yinz-then (run (list "pdfinfo" "-f" "1" "-l" (num->string pages) path))
    (lambda (result)
      (define found (text-page-geometry (stdout-text result)))
      (define sizes (make-vector pages LETTER))
      (for-each (lambda (n)
                  (when (and (>= n 1) (<= n pages))
                    (let ([g (hash-ref found n)])
                      (vector-set! sizes (- n 1)
                        (if (= 0 (modulo (caddr g) 180)) (list (car g) (cadr g)) (list (cadr g) (car g)))))))
        (hash-keys->list found))
      sizes)))

(define (open-doc path keep-page)
  (define full (resolve-path path))
  (set! failure "")
  (set! status (string-append "opening " (text-basename full) "…"))
  (yinz-request-render)
  (yinz-then (run (list "pdfinfo" full))
    (lambda (info)
      (if (not (ok? info))
        (fail (if (equal? (stderr-text info) "") (string-append "pdfinfo failed for " full) (stderr-text info)))
        (let* ([text (stdout-text info)]
               [count (text-field text "Pages")]
               [digits-found (and count (text-leading-digits count))]
               [pages (if (and digits-found (not (equal? digits-found ""))) (string->number digits-found) 0)]
               [title (or (text-field text "Title") "")])
          (if (< pages 1)
            (fail (string-append "no pages in " full))
            (yinz-then (page-sizes full pages)
              (lambda (sizes) (show-doc full title pages sizes keep-page)))))))))

(define (show-doc full title pages sizes keep-page)
  (set! cache (hash))
  (set! cache-order '())
  (set! pending (hash))
  (set! requested "")
  ;; A reload searches the fresh text for the same query.
  (set! queued (if keep-page (if search (hash-ref search "query") queued) ""))
  (clear-search)
  (set! texts #f)
  (set! doc-serial (+ doc-serial 1))
  (set! doc (hash "path" full "title" (if (equal? title "") (text-basename full) title) "pages" pages
                  "sizes" sizes "serial" doc-serial))
  (set! outline (vector))
  (set! labels #f)
  (set! meta-ready #f)
  (set! meta-problem "")
  (set! contents #f)
  (if keep-page
    (set! page (min page pages))
    (let ([last (recall full)])
      (set! page (min pages (max 1 (if last (hash-ref last "page") 1))))
      (set! scroll (if last (hash-ref last "scroll") 0))
      (when last
        (set! fit (hash-ref last "fit"))
        (set! invert (hash-ref last "invert")))))
  (set! saved "")
  (set! status "")
  (background (index-text doc))
  (background (load-meta doc))
  (yinz-request-render))

;; ---------------------------------------------------------------------------
;; Saved positions.

(define POSITIONS "position")

;; Where `path` was left, from the plugin's private data store.
(define (recall path)
  (with-handler
    (lambda (reason)
      (yinz-log (string-append "could not read the saved position: " (message-of reason)))
      #f)
    (let* ([reply (yinz-data-fetch json-null
                    (yinz-data-query POSITIONS (hash "filter" (yinz-data-eq "path" path) "limit" 1)))]
           [rows (hash-ref reply "rows")])
      (if (null? rows) #f
        (let* ([row (yinz-data-row reply (car rows))]
               [number (lambda (key fallback)
                         (define v (get row key json-null))
                         (if (number? v) v fallback))])
          (hash "page" (number "page" 1) "scroll" (number "scroll" 0)
                "fit" (if (equal? (get row "fit" json-null) "width") "width" "page")
                "invert" (equal? (get row "invert" json-null) #t)))))))

;; Save the current position when it has changed.
(define (remember)
  (when doc
    (let ([now (string-append (num->string page) ":" (num->string scroll) ":" fit ":" (if invert "true" "false"))])
      (unless (equal? now saved)
        (set! saved now)
        (with-handler
          (lambda (reason) (yinz-log (string-append "could not save the position: " (message-of reason))))
          (yinz-data-apply json-null
            (list (yinz-data-put POSITIONS
              (list (list "path" (hash-ref doc "path")) (list "page" page)
                    (list "scroll" scroll) (list "fit" fit) (list "invert" invert))
              (hash "uid" (hash-ref doc "path"))))))))))

;; ---------------------------------------------------------------------------
;; The outline and printed page labels.

;; Prints the outline, flattened with depths and resolved to 1-based pages, and
;; each page's label as JSON. Argument: document.
(define META-SCRIPT "
var d = Document.openDocument(scriptArgs[0]);
var out = {outline: [], labels: []};
function walk(items, depth) {
  for (var i = 0; i < items.length; i++) {
    var item = items[i], target = -1;
    try { if (item.uri) target = d.resolveLink(item.uri); } catch (e) {}
    out.outline.push({title: item.title || '', depth: depth, page: target + 1});
    if (item.down) walk(item.down, depth + 1);
  }
}
try { var o = d.loadOutline(); if (o) walk(o, 0); } catch (e) {}
// A page that fails to load, or a mutool without labels, only loses its label.
for (var i = 0, n = d.countPages(); i < n; i++) {
  var label = '';
  try { label = d.loadPage(i).getLabel() || ''; } catch (e) {}
  out.labels.push(label);
}
print(JSON.stringify(out));
")

(define (load-meta current)
  (yinz-then (if (equal? renderer "mutool") (run (mutool-run "meta.js" (list (hash-ref current "path")) #f)) (resolved #f))
    (lambda (result)
      (when (doc-is? current)
        (set! meta-ready #t)
        (if (not (and result (ok? result)))
          (begin
            (when result (yinz-log (string-append "could not read the outline: " (stderr-text result))))
            (set! meta-problem (if result "could not read the table of contents" "the table of contents needs mutool"))
            (yinz-request-render))
          (let* ([meta (yinz-json-parse (stdout-text result))]
                 [entries (get meta "outline" '())]
                 [found (get meta "labels" '())]
                 [pages (hash-ref current "pages")])
            (set! outline
              (list->vector
                (map (lambda (entry)
                       (define title (get entry "title" ""))
                       (define target (get entry "page" 0))
                       (define depth (get entry "depth" 0))
                       ;; Unresolved entries stay, unselectable, so their children keep their parent.
                       (hash "title" (if (string? title) title "")
                             "depth" (if (and (number? depth) (not (= depth 0))) depth 0)
                             "page" (if (and (number? target) (>= target 1) (<= target pages)) target 0)))
                  (if (list? entries) entries '()))))
            (let* ([printed (map (lambda (label) (if (string? label) label "")) (if (list? found) found '()))]
                   [plain (andmap (lambda (label i)
                                    (or (equal? label "") (equal? label (num->string i))))
                                  printed (range 1 (+ 1 (length printed))))])
              (set! labels (if plain #f (list->vector printed))))
            (yinz-request-render)))))))

;; The next page after the current one labelled `label`, wrapping, so that
;; repeating a number steps through parts whose numbering restarts.
(define (labelled-page printed label)
  (define count (vector-length printed))
  (let loop ([k 1])
    (if (> k count) #f
      (let ([i (modulo (+ (- page 1) k) count)])
        (if (equal? (vector-ref printed i) label) (+ i 1) (loop (+ k 1)))))))

;; Go to a typed page: a printed page label when the PDF has labels, else a page number.
(define (go-to-typed typed)
  (if (not labels)
    (go-to (string->number typed))
    (let ([target (labelled-page labels typed)])
      (if target (go-to target) (set! notice (string-append "no page labelled " typed))))))

(define (page-label n)
  (define label (vector-at labels (- n 1) ""))
  (if (equal? label "") (num->string n) label))

;; Run one of the scripts in the scratch directory. mutool run cannot write a
;; PNG to stdout, so when `png` is set the script's first argument is a fresh
;; file there, printed and removed afterwards.
(define (mutool-run script args png)
  (if (not png)
    (append (list "mutool" "run" (string-append scratch "/" script)) args)
    (append (list "sh" "-c" "s=$0/$1; shift; p=$(mktemp \"$0/XXXXXX\") || exit 1; trap 'rm -f \"$p\"' EXIT; mutool run \"$s\" \"$p\" \"$@\" && cat \"$p\""
                  scratch script)
            args)))

;; ---------------------------------------------------------------------------
;; Search.

(define (clear-search)
  (set! search #f)
  (set! boxes (hash))
  (set! boxes-pending (hash))
  (set! reveal-pending #f))

(define (index-text current)
  (yinz-then (run (list "pdftotext" "-cropbox" "-enc" "UTF-8" (hash-ref current "path") "-"))
    (lambda (result)
      (when (doc-is? current)
        (if (not (ok? result))
          (begin
            (set! queued "")
            (set! notice (string-append "search unavailable: "
                           (if (equal? (stderr-text result) "") "pdftotext failed" (stderr-text result))))
            (yinz-request-render))
          ;; Pages end with a form feed, so the text after the last one is empty.
          (let ([parts (list->vector (text-split-pages (stdout-text result)))])
            (set! texts (list->vector
                          (map (lambda (i) (text-collapse-space (vector-at parts i "")))
                            (range 0 (hash-ref current "pages")))))
            (unless (equal? queued "")
              (let ([query queued])
                (set! queued "")
                (start-search query)))
            (yinz-request-render)))))))

(define (hit-page hit) (car hit))
(define (hit-k hit) (cdr hit))
(define (search-hits) (hash-ref search "hits"))
(define (search-index) (hash-ref search "index"))
(define (set-search! key value) (set! search (hash-insert search key value)))
(define (current-hit) (and search (vector-at (search-hits) (search-index) #f)))

;; Smart case: the query ignores case unless it has an uppercase letter.
(define (start-search query)
  (define matcher (text-matcher query))
  (when (and matcher doc)
    (clear-search)
    (if (not texts)
      (set! queued query)
      (let ([hits (list->vector
                    (apply append
                      (map (lambda (i)
                             (define count (length (text-matches matcher (vector-ref texts i))))
                             (map (lambda (k) (cons (+ i 1) k)) (range 0 count)))
                        (range 0 (vector-length texts)))))])
        (if (= 0 (vector-length hits))
          (set! notice (string-append "no matches for \"" query "\""))
          (begin
            (set! search-id (+ search-id 1))
            (set! search (hash "id" search-id "query" query "matcher" matcher "hits" hits "index" 0))
            ;; Search forward from the current page, wrapping past the end.
            (let ([first (index-where (lambda (hit) (>= (hit-page hit) page)) hits)])
              (goto-hit (if (= first -1) 0 first) (= first -1)))))))))

;; Locate page `n`'s occurrences of the active search. The words are joined
;; with single spaces, as the indexed text was, and a match covering part of a
;; word gets the matching fraction of that word's box.
(define (load-boxes current id n)
  (set! boxes-pending (hash-insert boxes-pending n #t))
  (yinz-then (run (list "pdftotext" "-cropbox" "-bbox" "-f" (num->string n) "-l" (num->string n) (hash-ref current "path") "-"))
    (lambda (result)
      (set! boxes-pending (hash-remove boxes-pending n))
      (let ([active search])
        (when (and (doc-is? current) active (= (hash-ref active "id") id))
          (if (not (ok? result))
            ;; Keep the indexed matches; the page just goes without highlights.
            (begin
              (yinz-log (string-append "pdftotext -bbox failed for page " (num->string n) ": " (stderr-text result)))
              (set! boxes (hash-insert boxes n '())))
            (let* ([placed (place-words (text-bbox-words (stdout-text result)))]
                   [joined (car placed)]
                   [words (cdr placed)]
                   [found (map (lambda (m) (match-rects words (car m) (cdr m)))
                            (text-matches (hash-ref active "matcher") joined))])
              (set! boxes (hash-insert boxes n found))
              (reconcile n (length found))
              (when reveal-pending (reveal-hit))
              (yinz-request-render))))))))

;; The words joined with single spaces, and each word's (start end rect) in
;; the joined text. Like `if (joined !== '') joined += ' '`, an empty joined
;; text so far takes no space.
(define (place-words parsed)
  (let loop ([rest parsed] [pieces '()] [size 0] [words '()])
    (if (null? rest)
      (cons (apply string-append (reverse pieces)) (reverse words))
      (let* ([text (cdr (car rest))]
             [gap (if (= size 0) "" " ")]
             [start (+ size (string-length gap))]
             [end (+ start (string-length text))])
        (loop (cdr rest) (cons text (cons gap pieces)) end (cons (list start end (car (car rest))) words))))))

;; The rectangles of the words a match from `start` to `end` covers, each cut
;; to the covered fraction of its word.
(define (match-rects words start end)
  (map (lambda (word)
         (let* ([ws (car word)] [we (cadr word)] [rect (caddr word)]
                [x0 (exact->inexact (car rect))]
                [scale (/ (- (exact->inexact (caddr rect)) x0) (max 1 (- we ws)))])
           (list (+ x0 (* (max 0 (- start ws)) scale)) (cadr rect)
                 (+ x0 (* (- (min we end) ws) scale)) (cadddr rect))))
    (filter (lambda (word) (and (> (cadr word) start) (< (car word) end))) words)))

;; Trust the positioned count for page `n` if it disagrees with the index.
(define (reconcile n count)
  (when search
    (let* ([hits (vector->list (search-hits))]
           [before (filter (lambda (hit) (< (hit-page hit) n)) hits)]
           [after (filter (lambda (hit) (> (hit-page hit) n)) hits)]
           [old (- (length hits) (length before) (length after))])
      (unless (= old count)
        (let ([current (current-hit)]
              [query (hash-ref search "query")])
          (set-search! "hits" (list->vector (append before (map (lambda (k) (cons n k)) (range 0 count)) after)))
          (if (= 0 (vector-length (search-hits)))
            (begin
              (clear-search)
              (set! notice (string-append "no matches for \"" query "\"")))
            (begin
              (cond
                [(and current (= (hit-page current) n))
                  (set-search! "index" (+ (length before) (min (hit-k current) (- count 1))))]
                [(and current (> (hit-page current) n))
                  (set-search! "index" (+ (search-index) (- count old)))])
              (set-search! "index" (min (- (vector-length (search-hits)) 1) (max 0 (search-index)))))))))))


;; ---------------------------------------------------------------------------
;; Layout and rasters.

(define (page-size current n) (vector-at (hash-ref current "sizes") (- n 1) LETTER))

;; The placement box, in cells, for page `n` in the current mode: (w . h).
(define (layout current n rows cols)
  (define size (page-size current n))
  (define pw (car size))
  (define ph (cadr size))
  (define limit yinz-ui-image-max-dimension)
  (define (width-for h) (max 1 (js-round (/ (* h cell-height-px pw) (* ph cell-width-px)))))
  (let* ([w (max 1 (min cols limit))]
         [h (max 1 (js-round (/ (* w cell-width-px ph) (* pw cell-height-px))))])
    (when (and (equal? fit "page") (> h rows))
      (set! h (max 1 (min rows limit)))
      (set! w (min w (width-for h))))
    (when (> h limit)
      (set! h limit)
      (set! w (width-for h)))
    (cons w h)))
(define (box-w box) (car box))
(define (box-h box) (cdr box))

;; Page `n`'s highlights, once its matches are located; mutool only. A hash of
;; "key" and "marks", [x0, y0, x1, y1, current] per rectangle as JSON for the script.
(define (highlight n)
  (define found (get boxes n #f))
  (if (or (not search) (not (equal? renderer "mutool")) (not found) (null? found)) #f
    (let* ([hit (current-hit)]
           [current (if (and hit (= (hit-page hit) n)) (hit-k hit) -1)]
           [marks (apply append
                    (map (lambda (rects k)
                           (map (lambda (rect) (append rect (list (if (= k current) 1 0)))) rects))
                         found (range 0 (length found))))])
      (hash "key" (string-append (hash-ref search "query") "#" (num->string current)) "marks" (yinz-json-string marks)))))

;; Renders a page like `mutool draw -w -h` and fills translucent rectangles over
;; the matches, after inverting so the colours survive. Arguments: output file,
;; document, page, pixel width and height, invert (1/0), marks JSON.
(define HIGHLIGHT-SCRIPT "
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
")

(define (box-prefix n box)
  (string-append (num->string n) ":" (num->string (box-w box)) "x" (num->string (box-h box)) ":"
    (num->string cell-width-px) "x" (num->string cell-height-px) ":" (if invert "i" "")))
(define (raster-key n box hl)
  (string-append (box-prefix n box) (if hl (string-append ":" (hash-ref hl "key")) "")))

(define (raster-command path n box hl cell-width cell-height)
  (define px-w (num->string (* (box-w box) cell-width density)))
  (define px-h (num->string (* (box-h box) cell-height density)))
  (cond
    [hl (mutool-run "highlight.js" (list path (num->string n) px-w px-h (if invert "1" "0") (hash-ref hl "marks")) #t)]
    [(equal? renderer "mutool")
      (append (list "mutool" "draw" "-q" "-F" "png" "-o" "-" "-w" px-w "-h" px-h) (if invert (list "-I") '()) (list path (num->string n)))]
    [else (list "pdftoppm" "-png" "-f" (num->string n) "-l" (num->string n) "-scale-to-x" px-w "-scale-to-y" "-1" path)]))

(define (cache-put! key raster)
  (unless (hash-contains? cache key) (set! cache-order (append cache-order (list key))))
  (set! cache (hash-insert cache key raster))
  (let evict ()
    (when (> (hash-length cache) CACHE-LIMIT)
      (set! cache (hash-remove cache (car cache-order)))
      (set! cache-order (cdr cache-order))
      (evict))))

;; A deferred raster ("key" and "png") of page `n`, or #f.
(define (rasterize current n box)
  (define cell-width cell-width-px)
  (define cell-height cell-height-px)
  (define hl (highlight n))
  (define key (raster-key n box hl))
  (cond
    [(hash-contains? cache key) (resolved (hash-ref cache key))]
    [(hash-contains? pending key) (hash-ref pending key)]
    [else
      (let ([job (yinz-then (run (raster-command (hash-ref current "path") n box hl cell-width cell-height))
                   (lambda (result)
                     (if (and (not (ok? result)) (equal? renderer "mutool") (not hl))
                       (begin
                         (yinz-log (string-append "mutool failed (" (stderr-text result) "); falling back to pdftoppm"))
                         (set! renderer "pdftoppm")
                         (yinz-then (run (raster-command (hash-ref current "path") n box #f cell-width cell-height))
                           (lambda (retry) (finish-raster current n key retry))))
                       (finish-raster current n key result))))])
        (set! pending (hash-insert pending key job))
        job)]))

(define (finish-raster current n key result)
  (set! pending (hash-remove pending key))
  (cond
    [(not (doc-is? current)) #f]
    [(not (ok? result))
      (fail (if (equal? (stderr-text result) "") (string-append "could not render page " (num->string n)) (stderr-text result)))
      #f]
    [else
      (let ([raster (hash "key" key "png" (hash-ref result "stdout"))])
        (cache-put! key raster)
        raster)]))

(define (image-rows) (max 1 (- last-rows 1)))

;; ---------------------------------------------------------------------------
;; Moving around.

(define (go-to n)
  (if (not doc) #f
    (let ([target (min (hash-ref doc "pages") (max 1 n))])
      (if (= target page) #f
        (begin (set! page target) (set! scroll 0) #t)))))

(define (goto-hit i wrapped)
  (define hit (and search doc (vector-at (search-hits) i #f)))
  (if (not hit) #f
    (begin
      (set-search! "index" i)
      (set! notice (if wrapped "search wrapped" ""))
      (go-to (hit-page hit))
      (reveal-hit)
      #t)))

;; In fit-width mode, scroll the current match into view if it is off screen.
(define (reveal-hit)
  (define hit (current-hit))
  (set! reveal-pending #f)
  (when (and doc hit (= (hit-page hit) page) (equal? fit "width"))
    (let* ([found (get boxes page #f)]
           [occurrence (and found (< (hit-k hit) (length found)) (list-ref found (hit-k hit)))]
           [rect (and occurrence (not (null? occurrence)) (car occurrence))])
      (if (not rect)
        (set! reveal-pending #t)
        (let* ([rows (image-rows)]
               [box (layout doc page rows last-cols)]
               [ph (cadr (page-size doc page))]
               [top (js-floor (* (/ (cadr rect) ph) (box-h box)))]
               [bottom (js-ceil (* (/ (cadddr rect) ph) (box-h box)))])
          (unless (and (>= top scroll) (<= bottom (+ scroll rows)))
            (set! scroll (min (max 0 (- (box-h box) rows)) (max 0 (- top (quotient rows 3)))))))))))

(define (next-match delta)
  (if (not search) #f
    (let* ([count (vector-length (search-hits))]
           [i (+ (search-index) delta)])
      (goto-hit (modulo (+ i count) count) (or (< i 0) (>= i count))))))

;; Scroll within the page in fit-width mode, spilling over to neighbouring pages.
(define (scroll-by delta)
  (cond
    [(not doc) #f]
    [(equal? fit "page") (go-to (+ page (sign delta)))]
    [else
      (let* ([rows (image-rows)]
             [max-scroll (max 0 (- (box-h (layout doc page rows last-cols)) rows))]
             [next (+ scroll delta)])
        (cond
          ;; Show the edge of the current page before spilling onto its neighbour.
          [(and (< next 0) (> scroll 0)) (set! scroll 0) #t]
          [(and (> next max-scroll) (< scroll max-scroll)) (set! scroll max-scroll) #t]
          [(and (< next 0) (> page 1))
            (set! page (- page 1))
            (set! scroll (max 0 (- (box-h (layout doc page rows last-cols)) rows)))
            #t]
          [(and (> next max-scroll) (< page (hash-ref doc "pages")))
            (set! page (+ page 1))
            (set! scroll 0)
            #t]
          [else
            (let ([clamped (min max-scroll (max 0 next))])
              (if (= clamped scroll) #f (begin (set! scroll clamped) #t)))]))]))

(define (step lines) (if (equal? fit "width") lines 1))
(define (half) (max 1 (quotient (image-rows) 2)))

(define (action name)
  (cond
    [(equal? name "j") (lambda () (scroll-by (step 2)))]
    [(equal? name "k") (lambda () (scroll-by (- (step 2))))]
    [(equal? name "d") (lambda () (scroll-by (half)))]
    [(equal? name "u") (lambda () (scroll-by (- (half))))]
    [(equal? name "n") (lambda () (go-to (+ page 1)))]
    [(equal? name "p") (lambda () (go-to (- page 1)))]
    [(equal? name "g") (lambda () (go-to 1))]
    [(equal? name "G") (lambda () (go-to (if doc (hash-ref doc "pages") 1)))]
    [(equal? name "f")
      (lambda ()
        (set! fit (if (equal? fit "page") "width" "page"))
        (set! scroll 0)
        (reveal-hit)
        #t)]
    [(equal? name "i") (lambda () (set! invert (not invert)) #t)]
    [(equal? name "r") (lambda () (when doc (queue-open (hash-ref doc "path") #t)) #t)]
    [(equal? name "t") open-contents]
    [(equal? name "o")
      (lambda ()
        (set! opening #t)
        (input-replace! path-input (if doc (hash-ref doc "path") ""))
        #t)]
    [(equal? name "q") (lambda () (yinz-command "CloseSelf") #f)]
    [else #f]))
(define ALIASES
  (hash "Down" "j" "Up" "k" " " "n" "Space" "n" "PageDown" "n" "l" "n" "Right" "n"
        "Backspace" "p" "PageUp" "p" "h" "p" "Left" "p" "Home" "g" "End" "G" "w" "f" "Esc" "q"))

;; ---------------------------------------------------------------------------
;; The table of contents.

(define (entry-page entry) (hash-ref entry "page"))

(define (open-contents)
  (if (not (vector-some? (lambda (entry) (> (entry-page entry) 0)) outline))
    (begin
      (set! notice (cond [(not meta-ready) "reading the table of contents…"]
                         [(equal? meta-problem "") "no table of contents"]
                         [else meta-problem]))
      #t)
    (begin
      (set! contents #t)
      ;; Start on the section the current page is in: the entry with the latest
      ;; page at or before it, the last of those on a tie. Outlines need not be in
      ;; page order, so look at every entry.
      (let ([best (let loop ([i 0] [best -1])
                    (if (>= i (vector-length outline)) best
                      (let ([p (entry-page (vector-ref outline i))])
                        (loop (+ i 1)
                          (if (and (> p 0) (<= p page)
                                   (or (= best -1) (>= p (entry-page (vector-ref outline best)))))
                            i best)))))])
        (set! toc-index (if (= best -1) (index-where (lambda (entry) (> (entry-page entry) 0)) outline) best)))
      #t)))

;; Move the selection by `delta` entries, skipping entries without a page.
(define (move-contents delta)
  (define count (vector-length outline))
  (define target (min (- count 1) (max 0 (+ toc-index delta))))
  (define direction (if (> delta 0) 1 -1))
  ;; Settle on the nearest selectable entry, first in the direction of travel.
  (let try ([dirs (list direction (- direction))])
    (if (null? dirs) #f
      (let walk ([i target])
        (cond
          [(or (< i 0) (>= i count)) (try (cdr dirs))]
          [(> (entry-page (vector-ref outline i)) 0)
            (if (= i toc-index) #f (begin (set! toc-index i) #t))]
          [else (walk (+ i (car dirs)))])))))

(define (handle-contents-key name)
  (define jump (half))
  (define count (vector-length outline))
  (define moves
    (hash "j" 1 "Down" 1 "k" -1 "Up" -1 "d" jump "PageDown" jump " " jump "Space" jump "u" (- jump) "PageUp" (- jump)
          "g" (- count) "Home" (- count) "G" count "End" count))
  (cond
    [(hash-contains? moves name) (move-contents (hash-ref moves name))]
    [(equal? name "Enter")
      (let ([entry (vector-at outline toc-index #f)])
        (set! contents #f)
        (when (and entry (> (entry-page entry) 0)) (go-to (entry-page entry)))
        #t)]
    [(member name (list "Esc" "q" "t")) (set! contents #f) #t]
    [else #f]))

(define (draw-contents rows cols)
  (define area (max 1 (- rows 1)))
  (set! toc-top (min toc-index (max toc-top (+ (- toc-index area) 1))))
  (string-append
    (string-join
      (map (lambda (y)
             (define i (+ toc-top y))
             (define entry (vector-at outline i #f))
             (if (not entry) ""
               (let* ([right (if (> (entry-page entry) 0) (string-append " " (page-label (entry-page entry)) " ") " ")]
                      [left (string-append " " (repeat "  " (hash-ref entry "depth")) (text-sanitize (hash-ref entry "title")))]
                      [width (max 0 (- cols (text-width right)))]
                      [line (string-append (yinz-ui-pad (yinz-ui-truncate left width) width) right)])
                 (cond
                   [(= i toc-index) (string-append ESC "[7m" line ESC "[27m")]
                   [(> (entry-page entry) 0) line]
                   [else (string-append ESC "[2m" line ESC "[22m")]))))
        (range 0 area))
      "\n")
    "\n"))

;; ---------------------------------------------------------------------------
;; Keys.

(define (handle-opening-key key)
  (define result (yinz-ui-text-input-op path-input "Key" key))
  (cond
    [(equal? result "submit")
      (let ([path (trim (yinz-ui-text-input-op path-input "DrainText"))])
        (set! opening #f)
        (unless (equal? path "") (queue-open path #f)))]
    [(equal? result "cancel") (set! opening #f)])
  #t)

(define (handle-search-key key)
  (define result (yinz-ui-text-input-op search-input "Key" key))
  (cond
    [(equal? result "submit")
      (set! searching #f)
      (start-search (yinz-ui-text-input-op search-input "DrainText"))]
    [(equal? result "cancel") (set! searching #f)])
  #t)

(define (handle-key name ctrl)
  (define had-notice (not (equal? notice "")))
  (set! notice "")
  (or (handle-command-key name ctrl) had-notice))

(define (handle-command-key name ctrl)
  (cond
    [(and (= (string-length name) 1) (char-digit? (string-ref name 0)) (not ctrl))
      (let ([typed (string-append digits name)])
        (set! digits (if (> (string-length typed) 6) (substring typed (- (string-length typed) 6) (string-length typed)) typed)))
      #t]
    [(and (not (equal? digits "")) (or (equal? name "Enter") (equal? name "Esc")))
      (when (equal? name "Enter") (go-to-typed digits))
      (set! digits "")
      #t]
    [else
      (let ([had-digits (not (equal? digits ""))])
        (set! digits "")
        (cond
          [(and (equal? name "/") (not ctrl))
            (set! searching #t)
            (input-replace! search-input "")
            #t]
          ;; While a search is active n/N step through matches and Esc ends the
          ;; search; Space, PgDn and the rest still page through their aliases.
          [(and (or search (not (equal? queued ""))) (not ctrl) (equal? name "n")) (next-match 1)]
          [(and (or search (not (equal? queued ""))) (not ctrl) (equal? name "N")) (next-match -1)]
          [(and (or search (not (equal? queued ""))) (not ctrl) (equal? name "Esc"))
            (set! queued "")
            (clear-search)
            #t]
          [else
            (let ([run-action (action (get ALIASES name name))])
              (if run-action (or (run-action) had-digits) had-digits))]))]))

;; ---------------------------------------------------------------------------
;; Drawing.

(define (status-text)
  (cond
    [(not (equal? failure "")) (string-append ESC "[31m" failure ESC "[39m")]
    [(not doc) (if (equal? status "") "no document — press o to open a PDF" status)]
    [else
      (let* ([mode (if (equal? fit "page") "fit page" "fit width")]
             [printed (if (equal? (page-label page) (num->string page)) "" (string-append "p. " (page-label page) "  "))]
             [hit (current-hit)])
        (string-append
          ESC "[1m" (hash-ref doc "title") ESC "[22m  " printed (num->string page) "/" (num->string (hash-ref doc "pages")) "  " mode
          (if invert "  inverted" "")
          (if (equal? digits "") "" (string-append "  go to: " digits))
          (cond
            [(and search hit)
              (string-append "  match " (num->string (+ (search-index) 1)) "/" (num->string (vector-length (search-hits)))
                " · page " (num->string (hit-page hit)))]
            [(not (equal? queued "")) "  indexing…"]
            [else ""])
          (if (equal? notice "") "" (string-append "  " notice))
          (if (equal? status "") "" (string-append "  " status))))]))

(define (status-line cols)
  (cond
    [opening (yinz-ui-render path-input (yinz-ui-coordinates 0 0 cols 1))]
    [searching (yinz-ui-render search-input (yinz-ui-coordinates 0 0 cols 1))]
    [else
      (let* ([left (if contents
                     (string-append ESC "[1mcontents" ESC "[22m  " (num->string (+ toc-index 1)) "/" (num->string (vector-length outline)))
                     (status-text))]
             [hint (cond
                     [contents "j/k move  Enter go  Esc close"]
                     [search "n/N match  Esc clear  Space/p page  / search  q quit"]
                     [else "j/k scroll  n/p page  / search  t contents  f fit  o open  q quit"])]
             [room (- cols (text-width left) (text-width hint))]
             [line (if (>= room 2) (string-append left (make-string room #\space) hint) left)])
        (string-append ESC "[7m" (yinz-ui-pad (yinz-ui-truncate line cols) cols) ESC "[0m"))]))

(define (placeholder message area cols)
  (define top (quotient area 2))
  (string-append (newlines top) (yinz-ui-center message cols) (newlines (- area top))))

(define (prefetch current area cols)
  (for-each (lambda (n)
              (when (and (>= n 1) (<= n (hash-ref current "pages")))
                (background (rasterize current n (layout current n area cols)))))
    (list (+ page 1) (- page 1))))

;; Start locating the current page's matches when it has some.
(define (locate-matches current)
  (when (and search (equal? renderer "mutool") (not (hash-contains? boxes page)) (not (hash-contains? boxes-pending page))
             (vector-some? (lambda (hit) (= (hit-page hit) page)) (search-hits)))
    (background (load-boxes current (hash-ref search "id") page))))

;; A raster of the current page to show while its highlights are drawn.
(define (stand-in box)
  (define sent (get shown (client-id) #f))
  (define same-box (and sent (starts-with? (hash-ref sent "key") (box-prefix page box))))
  (define plain (raster-key page box #f))
  (cond
    [(hash-contains? cache plain) (hash-ref cache plain)]
    [(and sent same-box (hash-contains? cache (hash-ref sent "key"))) (hash-ref cache (hash-ref sent "key"))]
    [else #f]))

(define (draw-page current rows cols)
  (define area (max 1 (- rows 1)))
  (define box (layout current page area cols))
  (set! scroll (if (equal? fit "width") (min scroll (max 0 (- (box-h box) area))) 0))
  (locate-matches current)
  (let* ([key (raster-key page box (highlight page))]
         [ready (get cache key #f)])
    (cond
      [ready (prefetch current area cols)]
      [(not (equal? requested key))
        (set! requested key)
        (background (yinz-then (rasterize current page box) (lambda (_) (yinz-request-render))))])
    (let ([raster (or ready (stand-in box))])
      (if (not raster) (placeholder (string-append "rendering page " (num->string page) "…") area cols)
        (let* ([client (client-id)]
               [sent (get shown client #f)]
               [head ""])
          (unless (and sent (equal? (hash-ref sent "key") (hash-ref raster "key")))
            (when sent (set! head (string-append ESC "_Ga=d,d=I,i=" (num->string (hash-ref sent "id")) ",q=2" ESC "\\")))
            (set! sent (hash "id" next-id "key" (hash-ref raster "key")))
            (set! next-id (+ next-id 1))
            (set! head (string-append head (yinz-ui-image-png (hash-ref sent "id") (hash-ref raster "png"))
                         (yinz-ui-image-place (hash-ref sent "id") (box-w box) (box-h box))))
            (set! shown (hash-insert shown client sent)))
          (let* ([pad (make-string (max 0 (quotient (- cols (box-w box)) 2)) #\space)]
                 [top (if (equal? fit "page") (max 0 (quotient (- area (box-h box)) 2)) 0)]
                 [lines (map (lambda (y)
                               (define r (+ (- y top) scroll))
                               (if (and (>= r 0) (< r (box-h box)))
                                 (string-append pad (yinz-ui-image-row (hash-ref sent "id") r (box-w box)))
                                 ""))
                          (range 0 area))])
            (string-append head (string-join lines "\n") "\n")))))))

;; ---------------------------------------------------------------------------
;; Lifecycle.

(define (detect-tools)
  (yinz-then (run (list "sh" "-c" "echo \"$HOME\"; command -v mutool || true"))
    (lambda (probe)
      (unless (ok? probe)
        (error (if (equal? (stderr-text probe) "") "could not detect PDF tools; reload to retry" (stderr-text probe))))
      (let* ([found (string-split (stdout-text probe) "\n")]
             [mutool (if (> (length found) 1) (cadr found) "")])
        (set! home-dir (if (null? found) "" (car found)))
        (if (equal? mutool "")
          (set! renderer "pdftoppm")
          (yinz-then
            (run (list "sh" "-c"
                   "d=$(mktemp -d -t yinz-pdf-reader.XXXXXX) && printf %s \"$0\" > \"$d/meta.js\" && printf %s \"$1\" > \"$d/highlight.js\" && echo \"$d\""
                   META-SCRIPT HIGHLIGHT-SCRIPT))
            (lambda (made)
              (set! scratch (trim (stdout-text made)))
              (when (or (not (ok? made)) (equal? scratch ""))
                (yinz-log (string-append "could not write the mutool scripts: " (stderr-text made)))
                (set! scratch "")
                (set! renderer "pdftoppm")))))))))

(define initialization (resolved #t))
(define opens (resolved #t))

(define (queue-open path keep-page)
  (set! opens
    (yinz-catch
      (yinz-then opens (lambda (_) (yinz-then initialization (lambda (_) (open-doc path keep-page)))))
      (lambda (reason) (fail (message-of reason))))))

(define (initialize)
  (yinz-then (yinz-wait-for-permissions '("RunCommands" "PluginData"))
    (lambda (_)
      (yinz-data-define json-null
        (hash "name" POSITIONS "version" 1
              "attrs" (list (yinz-data-attr "path" 'text (hash "required" #t "unique" #t)) (yinz-data-attr "page" 'int (hash "required" #t))
                            (yinz-data-attr "scroll" 'int) (yinz-data-attr "fit" 'text)
                            (yinz-data-attr "invert" 'bool))))
      (detect-tools))))

(define (use-cell-geometry geometry)
  (set! cell-width-px (or cell-width-override (get geometry "width" 12)))
  (set! cell-height-px (or cell-height-override (get geometry "height" 22))))

(define (load configuration)
  (set! cell-width-override (config-number configuration "cell_width" #f))
  (set! cell-height-override (config-number configuration "cell_height" #f))
  (set! cell-geometries (hash (client-id) (yinz-cell-pixel-size)))
  (use-cell-geometry (hash-ref cell-geometries (client-id)))
  (set! density (config-number configuration "density" density))
  (set! fit (if (equal? (get configuration "fit" "page") "width") "width" "page"))
  (set! invert (equal? (get configuration "invert" "false") "true"))
  (set! initial-cwd (hash-ref (yinz-command "GetPluginIds") "initial_cwd"))
  (set! initialization (initialize))
  (background initialization)
  (yinz-command (hash "Subscribe" '("Key" "Mouse" "CellPixelSizeChanged")))
  (let ([file (get configuration "file" "")])
    (unless (equal? file "") (queue-open file #f))))

(define (unload)
  (if (equal? scratch "") #f (run (list "rm" "-rf" scratch))))

(define (update event)
  (cond
    [(not (hash? event)) #f]
    [(hash-contains? event "CellPixelSizeChanged")
      (define geometry (hash-ref event "CellPixelSizeChanged"))
      (define changed (not (equal? geometry (get cell-geometries (client-id) #f))))
      (set! cell-geometries (hash-insert cell-geometries (client-id) geometry))
      (when changed
        (set! cache (hash))
        (set! cache-order '())
        (set! requested ""))
      changed]
    [(hash-contains? event "Key")
      (let ([key (hash-ref event "Key")])
        (cond
          [opening (handle-opening-key key)]
          [searching (handle-search-key key)]
          [contents (handle-contents-key (yinz-key-name (hash-ref key "bare_key")))]
          [else (handle-key (yinz-key-name (hash-ref key "bare_key")) (key-ctrl? key))]))]
    [(hash-contains? event "Mouse")
      (let ([mouse (hash-ref event "Mouse")])
        (cond
          [(and (hash? mouse) (hash-contains? mouse "ScrollDown")) (if contents (move-contents 3) (scroll-by (step 3)))]
          [(and (hash? mouse) (hash-contains? mouse "ScrollUp")) (if contents (move-contents -3) (scroll-by (- (step 3))))]
          [else #f]))]
    [else #f]))

(define (pipe message)
  (define payload (get message "payload" json-null))
  (if (or (not (equal? (get message "name" "") "open")) (json-null? payload) (equal? payload "")) #f
    (begin (queue-open payload #f) #t)))

(define (render rows cols)
  (define client (client-id))
  (unless (hash-contains? cell-geometries client)
    (set! cell-geometries (hash-insert cell-geometries client (yinz-cell-pixel-size))))
  (use-cell-geometry (hash-ref cell-geometries client))
  (set! last-rows rows)
  (set! last-cols cols)
  (let ([body (cond
                [(not doc) (newlines (- rows 1))]
                [contents (draw-contents rows cols)]
                [else (draw-page doc rows cols)])])
    ;; Every change of position is followed by a render, so save it here.
    (remember)
    (string-append body (status-line cols))))
