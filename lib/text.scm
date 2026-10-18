;; PDF-specific parsing on the confined SDK's Unicode regex operations.
(provide text-collapse-space text-field text-page-geometry text-decode-xml text-bbox-words
  text-matcher text-matches text-split-pages text-digits? text-leading-digits text-basename)

(define whitespace (regex "\\s+"))
(define uppercase (regex "\\p{Lu}"))
(define digits (regex "^[0-9]+$"))
(define leading-digits (regex "^[0-9]*"))
(define last-segment (regex "[^/]*$"))
(define page-size (regex "^Page\\s+([0-9]+)\\s+size:\\s+([0-9.]+) x ([0-9.]+)" "m"))
(define page-rotation (regex "^Page\\s+([0-9]+)\\s+rot:\\s+([0-9]+)" "m"))
(define bbox-word (regex "<word xMin=\"([0-9.]+)\" yMin=\"([0-9.]+)\" xMax=\"([0-9.]+)\" yMax=\"([0-9.]+)\">(.*?)</word>"))

(define (text-digits? s) (regex-match? digits s))
(define (text-collapse-space s) (regex-replace-all whitespace s " "))
(define (text-split-pages s) (string-split s "\f"))
;; Both patterns match the empty string, so these always find a match.
(define (text-leading-digits s) (car (hash-ref (regex-find leading-digits s) "groups")))
(define (text-basename path) (car (hash-ref (regex-find last-segment path) "groups")))

;; Restrict separators to their line, so a missing value cannot consume the next field.
(define (text-field text name)
  (define match (regex-find (regex (string-append "^" (regex-escape name) ":[^\\S\\r\\n]+([^\\r\\n]+)$") "m") text))
  (and match (string-trim (list-ref (hash-ref match "groups") 1))))

(define (text-page-geometry text)
  (define rotations
    (foldl (lambda (match found)
             (define groups (hash-ref match "groups"))
             (hash-insert found (string->number (list-ref groups 1)) (string->number (list-ref groups 2))))
      (hash) (regex-find-all page-rotation text)))
  (foldl (lambda (match found)
           (define groups (hash-ref match "groups"))
           (define page (string->number (list-ref groups 1)))
           (define width (string->number (list-ref groups 2)))
           (define height (string->number (list-ref groups 3)))
           (if (or (hash-contains? found page) (not width) (not height)) found
             (hash-insert found page (list width height (if (hash-contains? rotations page) (hash-ref rotations page) 0)))))
    (hash) (regex-find-all page-size text)))

;; Decode ampersands last, so an escaped entity is decoded only once.
(define entities
  (map (lambda (pair) (cons (regex (car pair)) (cdr pair)))
    '(("&lt;" . "<") ("&gt;" . ">") ("&quot;" . "\"") ("&apos;" . "'") ("&amp;" . "&"))))
(define (text-decode-xml text)
  (foldl (lambda (entity text) (regex-replace-all (car entity) text (cdr entity))) text entities))

(define (text-bbox-words xml)
  (filter (lambda (word) word)
    (map (lambda (match)
           (define groups (hash-ref match "groups"))
           (define coordinates (map string->number (take (cdr groups) 4)))
           (and (andmap number? coordinates)
             (cons coordinates (text-decode-xml (list-ref groups 5)))))
      (regex-find-all bbox-word xml))))

;; Smart case uses the exact Lu category; titlecase letters still ignore case.
(define (text-matcher query)
  (define words (string-split query))
  (and (pair? words)
    (regex (string-join (map regex-escape words) "\\s+")
      (if (regex-match? uppercase query) "" "i"))))

;; Unicode scalar indices remain valid across simple-fold matches.
(define (text-matches matcher text)
  (map (lambda (match) (cons (hash-ref match "start") (hash-ref match "end")))
    (regex-find-all matcher text)))
