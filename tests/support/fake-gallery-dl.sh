#!/bin/sh
# Minimal stand-in for gallery-dl used by the host end-to-end test.
# Pure POSIX sh so the engine spawn still works after ScrubbedEngineEnvironment
# drops untrusted PATH entries (a `#!/usr/bin/env node` shebang would lose `node`).
set -eu

destination=""
url=""
prev=""
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    printf '%s\n' '1.30.9'
    exit 0
  fi
  if [ "$prev" = "--destination" ]; then
    destination=$arg
  elif [ "$prev" = "--" ]; then
    url=$arg
  fi
  prev=$arg
done

if [ -z "$destination" ] || [ -z "$url" ]; then
  printf '%s\n' '[gallery-dl][error] missing destination or url' >&2
  exit 2
fi

case $url in
  *fail*)
    printf '%s\n' '[example][error] HttpError: 404 Not Found' >&2
    exit 1
    ;;
esac

dir="$destination/example/album ação"
mkdir -p "$dir"

case $url in
  *slow*)
    file="$dir/slow-$$.jpg"
    printf 'data' >"$file"
    printf '%s\n' "$file"
    sleep 60
    exit 0
    ;;
esac

for name in 1.jpg 2.png; do
  file="$dir/$name"
  printf 'data' >"$file"
  printf '%s\n' "$file"
done
printf '# %s\n' "$dir/0.jpg"
