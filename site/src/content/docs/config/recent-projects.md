---
title: Recent projects
description: "projects.json, the list behind the o picker and the welcome page."
---

Recent projects live beside `config.json` in `projects.json`: up to 20 entries, newest first, each with the folder (`root`), the note open when it was left (`lastNote`), its Preview line (`top`) and when (`at`).

The start and every workspace opened with <kbd>o</kbd> are recorded, and updated when you switch away or quit. A single note is recorded under its vault (or folder). A piped document is never recorded.

They fill the <kbd>o</kbd> picker and the [welcome page](/brothy/usage/navigating-notes/#the-welcome-page).

The file is only state: one that does not parse is replaced.
