#!/usr/bin/env bash
# Export HEAD of the current branch into a NEW repo with a single commit, so the
# private history never leaves this machine. Does not push or create anything remote.
# Prompts for the GitHub owner and substitutes OWNER in the export before the commit.
# usage: scripts/publish-fresh.sh <target-dir> <author-email> [author-name]
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <target-dir> <author-email> [author-name]" >&2
  exit 1
fi
target=$1
email=$2
name=${3:-$(git config user.name)}

[ -e "$target" ] && { echo "$target already exists" >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "working tree has uncommitted changes" >&2; exit 1; }

mkdir -p "$target"
git archive HEAD | tar -x -C "$target"
cd "$target"
read -r -p "GitHub user or org to replace OWNER with: " owner
[ -n "$owner" ] || { echo "owner is empty" >&2; exit 1; }
grep -rl OWNER . --exclude=publish-fresh.sh | xargs -r sed -i "s/OWNER/$owner/g"
git init -q -b main
git add -A
GIT_AUTHOR_NAME=$name GIT_AUTHOR_EMAIL=$email GIT_COMMITTER_NAME=$name GIT_COMMITTER_EMAIL=$email \
  git commit -q -m "Initial release"

echo "Created $target with one commit:"
git log --format='%an <%ae> / %cn <%ce>'
cat <<MSG

Next steps (nothing was pushed):
  cd $target
  gh repo create $owner/brothy --public --source=. --push
  git tag v0.1.0 && git push origin v0.1.0   # triggers the release workflow
MSG
