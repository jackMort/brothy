# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately via
[GitHub private vulnerability reporting](https://github.com/jackMort/brothy/security/advisories/new).
Include the version (`brothy --version`), your OS and terminal, and steps to reproduce.

You can expect an acknowledgement within 7 days. Fixes are released as a patch version
and credited in the changelog unless you prefer otherwise.

## Scope

brothy reads local Markdown files and writes only `~/.config/brothy/*.json`. Issues such as
crafted Markdown causing code execution, writes outside the config directory, or terminal
escape-sequence injection are in scope.
