(require "./text.scm")

(define (spans query text) (text-matches (text-matcher query) text))

(test "collapses whitespace runs to single spaces" (lambda ()
  (assert-equal (text-collapse-space "  a\n\tb  c ") " a b c ")
  (assert-equal (text-collapse-space "") "")))

(test "reads pdfinfo fields from the start of a line" (lambda ()
  (define info "Title:          A  Book \nAuthor:  Me\nPages:          12\nPage size: 1 x 2\n")
  (assert-equal (text-field info "Title") "A  Book")
  (assert-equal (text-field info "Pages") "12")
  (assert-equal (text-field info "Subject") #f)
  (assert-equal (text-field "Title:\n" "Title") #f)
  (assert-equal (text-field "XPages: 3\n" "Pages") #f)))

(test "reads page sizes and rotations" (lambda ()
  (define info (string-append
    "Page    1 size: 612 x 792 pts (letter)\nPage    1 rot:  0\n"
    "Page    2 size: 595.28 x 841.89 pts (A4)\nPage    2 rot:  90\n"
    "Page    3 size: 100x200 pts\n"))
  (define pages (text-page-geometry info))
  (assert-equal (hash-ref pages 1) (list 612 792 0))
  (assert-equal (hash-ref pages 2) (list 595.28 841.89 90))
  (assert (not (hash-contains? pages 3)))))

(test "decodes the five XML entities only" (lambda ()
  (assert-equal (text-decode-xml "a&amp;b&lt;&gt;&quot;&apos;&nbsp;&") "a&b<>\"'&nbsp;&")))

(test "scans pdftotext bbox words" (lambda ()
  (define xml (string-append
    "<page width=\"612\">\n"
    "    <word xMin=\"72.000000\" yMin=\"80.5\" xMax=\"100\" yMax=\"90\">Page</word>\n"
    "    <word xMin=\"101\" yMin=\"80.5\" xMax=\"110\" yMax=\"90\">R&amp;D</word>\n"
    "    <word xMin=\"bad\" yMin=\"1\" xMax=\"2\" yMax=\"3\">skip</word>\n"
    "    <word xMin=\"1\" yMin=\"2\" xMax=\"3\" yMax=\"4\">雪</word>\n"))
  (assert-equal (text-bbox-words xml)
    (list (cons (list 72.0 80.5 100 90) "Page") (cons (list 101 80.5 110 90) "R&D") (cons (list 1 2 3 4) "雪")))))

(test "smart case ignores case unless the query has an uppercase letter" (lambda ()
  (assert-equal (spans "page" "Page one, PAGE two, page") (list (cons 0 4) (cons 10 14) (cons 20 24)))
  (assert-equal (spans "Page" "Page one, PAGE two, page") (list (cons 0 4)))
  (assert-equal (spans "émile" "ÉMILE émile") (list (cons 0 5) (cons 6 11)))))

(test "spaces in the query match any whitespace run" (lambda ()
  (assert-equal (spans " new   york " "new york, new\n\t york, newyork") (list (cons 0 8) (cons 10 20)))
  (assert-equal (text-matcher "   ") #f)))

(test "matches do not overlap and regex characters are literal" (lambda ()
  (assert-equal (spans "aa" "aaaa") (list (cons 0 2) (cons 2 4)))
  (assert-equal (spans "a.b" "axb a.b") (list (cons 4 7)))
  (assert-equal (spans "(x)" "f(x) (x)") (list (cons 1 4) (cons 5 8)))))

(test "splits pages on form feeds" (lambda ()
  (assert-equal (text-split-pages "one\ftwo\f") (list "one" "two" ""))))


(test "Unicode simple folding preserves source indices" (lambda ()
  (assert-equal (spans "s" "s ſ S") (list (cons 0 1) (cons 2 3) (cons 4 5)))
  (assert-equal (spans "k" "k K K") (list (cons 0 1) (cons 2 3) (cons 4 5)))
  (assert-equal (spans "σ" "σ ς Σ") (list (cons 0 1) (cons 2 3) (cons 4 5)))
  (assert-equal (spans "ǅ" "ǅ ǆ Ǆ") (list (cons 0 1) (cons 2 3) (cons 4 5)))
  (assert-equal (spans "Ǆ" "ǅ ǆ Ǆ") (list (cons 4 5)))
  (assert-equal (spans "é" "🙂É é é") (list (cons 1 2) (cons 3 4)))
  (assert-equal (spans "ss" "ß ss") (list (cons 2 4)))
  (assert-equal (spans "ß" "ss ß ẞ") (list (cons 3 4) (cons 5 6)))))

(test "PDF parsers preserve malformed and escaped input" (lambda ()
  (assert-equal (text-field "Title:\nAuthor: Me\n" "Title") #f)
  (assert-equal (text-field "A.B: value\nAxB: wrong\n" "A.B") "value")
  (assert-equal (text-decode-xml "&amp;lt;&amp;amp;&amp;quot;") "&lt;&amp;&quot;")
  (assert-equal (text-bbox-words "<word xMin=\"1..2\" yMin=\"1\" xMax=\"2\" yMax=\"3\">skip</word>") '())))

(test "reads leading digits and the last path segment" (lambda ()
  (assert-equal (text-leading-digits "12 pages") "12")
  (assert-equal (text-leading-digits "x12") "")
  (assert-equal (text-leading-digits "") "")
  (assert-equal (text-basename "/books/Pachev, Sasha #?%2C 雪.pdf") "Pachev, Sasha #?%2C 雪.pdf")
  (assert-equal (text-basename "plain.pdf") "plain.pdf")
  (assert-equal (text-basename "/books/") "")))
