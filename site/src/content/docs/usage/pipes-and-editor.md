---
title: Pipes & editor
description: "Read Markdown from a pipe with brothy -, and open the note in your editor with e."
---

<!-- Mirrors README § Quick start (From a pipe) and Keys (e): update both. -->

## Reading a pipe

`curl -s … | brothy` or `brothy - < note.md` shows the piped text as a single document titled `stdin` (up to 5 MB; more stops with `brothy: input too large (limit 5 MB)`). Keys are read from `/dev/tty`, so stdout and a controlling terminal are still required.

What changes for a pipe:

- There is no Files tab (<kbd>1</kbd> Outline, <kbd>2</kbd> Info), no live reload and no recent-project entry.
- `a` summarizes for this run only (never cached, glosses too).
- `[[links]]` resolve against the notes under the current folder, which is scanned in the background right after start (a link used sooner scans at once; until then every link looks unresolved).

## Editing

<kbd>e</kbd> opens the note in `$VISUAL`, else `$EDITOR` (fallback `vi`), at the line at the top of the view: exact in Source, from the nearest heading in Preview. VS Code, VSCodium and Cursor get `-g path:line` and Sublime Text `path:line`; everything else gets `+line path`. brothy resumes and reloads when the editor exits, and says so when it exits with an error.

On a piped document there is nothing to edit (`e` says so). On a note followed from piped input the editor reads its keys from `/dev/tty` too.

brothy is a reader for a folder of notes, not an editor: this is the only other program it ever runs.
