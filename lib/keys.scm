(provide key-ctrl?)

(define (key-ctrl? key) (if (member "Ctrl" (hash-ref key "key_modifiers")) #t #f))
