;; Command palette entry for the PDF reader -- "Open PDF…" picks a PDF from the
;; focused pane's git project, its main checkout and every worktree, with the
;; builtin file finder (fzf in an overlay), and opens it in the reader.
;; "Open PDF from folder…" picks any folder under the home directory in one
;; finder, then a PDF under that folder in a second.
;;
;; Load it in the background, so the action is there in every session:
;;   load_plugins { "file:///path/to/yinz-pdf-reader/palette.scm" { shared true; }; }
;; Installed from git, set `reader` to the reader's alias, so picks reach the
;; same reader identity whichever commit is installed.
(provide LIST FOLDERS folder-list)

;; Every PDF git tracks or would track (untracked but not ignored) in each
;; checkout of the repository the finder starts in, skipping a bare repository
;; and worktrees whose directory is gone, and files deleted from the working
;; tree. Outside a checkout, the PDFs under the directory, hidden ones left
;; out. Paths are absolute, as the reader does not open in the finder's
;; directory, and are joined with printf so no character in them is special.
;; git's errors would draw over fzf, so they are dropped.
(define LIST
  (string-join
    (list
      "if git rev-parse --git-dir >/dev/null 2>&1; then"
      "  git worktree list --porcelain 2>/dev/null |"
      "  awk '/^worktree /{w=substr($0,10)} /^(bare|prunable)/{w=\"\"} /^$/{if(w!=\"\")print w; w=\"\"} END{if(w!=\"\")print w}' |"
      "  while IFS= read -r w; do"
      "    git -C \"$w\" -c core.quotePath=false ls-files -co --exclude-standard -- ':(icase)*.pdf' 2>/dev/null |"
      "    while IFS= read -r f; do [ -f \"$w/$f\" ] && printf '%s/%s\\n' \"$w\" \"$f\"; done"
      "  done"
      "else"
      "  find \"$PWD\" -mindepth 1 -name '.*' -prune -o -type f -iname '*.pdf' -print"
      "fi")
    "\n"))

;; The directories under the home directory, itself first, hidden ones left
;; out, for the first step of "Open PDF from folder…".
(define FOLDERS
  "printf '%s\\n' \"$HOME\"; find \"$HOME\" -mindepth 1 -name '.*' -prune -o -type d -print 2>/dev/null")

;; The PDFs anywhere under `dir`, hidden ones left out.
(define (folder-list dir)
  (string-append "find '" (string-replace dir "'" "'\\''") "' -mindepth 1 -name '.*' -prune -o -type f -iname '*.pdf' -print 2>/dev/null"))

(define reader "")
(define plugin-id 0)

;; Launch the finder through the user's `file-finder` alias, so its geometry
;; and other settings apply, with this plugin's listing and opener on top.
;; `overlay` is read by the host, not the finder, and matches the default
;; keybinding's launch.
(define (launch file-command openers)
  (hash "LaunchOrFocusPlugin"
    (hash "plugin" (hash "Alias" (hash "name" "file-finder"
                                       "configuration" (hash "overlay" "true" "file_command" file-command
                                                             "openers_json" (yinz-json-string openers))
                                       "initial_cwd" json-null "run_plugin" json-null))
          "should_float" #t "move_to_focused_tab" #t "should_open_in_place" #f
          "close_replaced_pane" #f "skip_cache" #f "tab_id" json-null)))

(define (run-action action) (yinz-command (hash "RunAction" (list action (hash)))))

;; Picks come back to this instance as `open`: a reader the finder launched
;; itself would float.
(define (to-palette) (hash "pdf" (hash "plugin_id" plugin-id "message" "open")))

;; Pipe the pick to the reader, launching it as a tiled pane when it is not
;; running. `focus` asks it to focus itself, as a pipe to a running plugin does not.
(define (to-reader target path)
  (hash "KeybindPipe"
    (hash "name" "open" "payload" path "args" (hash "focus" "true") "plugin" target "configuration" json-null
          "launch_new" #f "skip_cache" #f "floating" #f "in_place" #f "cwd" json-null "pane_title" json-null
          "plugin_id" json-null)))

(define (finder-launch) (launch LIST (to-palette)))

;; The first step: a finder over folders, whose pick comes back to this
;; instance as `folder`. A folder named like a PDF would otherwise go to the reader.
(define (folder-launch)
  (define back (hash "plugin_id" plugin-id "message" "folder"))
  (launch FOLDERS (hash "pdf" back "default" back)))

(define OPEN-PDF
  (hash "id" "open" "label" "Open PDF…"
        "aliases" '("pdf reader" "open document" "pdf open" "read pdf")
        "description" "Find a PDF in this project or its worktrees"
        "run" (lambda (values context)
                (run-action (finder-launch)) (void))))

(define OPEN-FROM-FOLDER
  (hash "id" "open-from-folder" "label" "Open PDF from folder…"
        "aliases" '("pdf folder" "pdf directory" "browse pdfs")
        "description" "Pick a folder, then a PDF under it"
        "run" (lambda (values context) (run-action (folder-launch)) (void))))

(define (load configuration)
  (define configured (if (hash-contains? configuration "reader") (hash-ref configuration "reader") ""))
  (set! reader (if (equal? configured "") (yinz-plugin-resolve "./main.scm") configured))
  (set! plugin-id (hash-ref (yinz-command "GetPluginIds") "plugin_id"))
  (yinz-then (yinz-wait-for-permissions '("ReadApplicationState" "RunActionsAsUser"))
    (lambda (_)
      (yinz-palette-register "pdf-reader" "PDF reader" (list OPEN-PDF OPEN-FROM-FOLDER)))))

(define (pipe message)
  (define name (hash-ref message "name"))
  (define payload (if (hash-contains? message "payload") (hash-ref message "payload") json-null))
  (when (and (member name '("folder" "open")) (string? payload) (not (equal? payload "")))
    ;; Delivering a pick surfaces this background plugin as a floating pane;
    ;; put it back out of sight.
    (yinz-command "HideSelf")
    (run-action (if (equal? name "folder") (launch (folder-list payload) (to-palette)) (to-reader reader payload))))
  #f)
