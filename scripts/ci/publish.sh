#!/usr/bin/env bash
set -uo pipefail
version="${TAG#v}"
name=@ai-ecoverse/slicc-bios
here="$(cd "$(dirname "$0")" && pwd)"
waits=()
[ -n "${SERVED_WAITS:-}" ] && waits=(--waits "$SERVED_WAITS")
npm version --no-git-tag-version --allow-same-version "$version" || exit 1
integrity=$(node "$here/served.mjs" pack) || exit 1
echo "packed $name@$version: $integrity"
listed() { [ "$(npm view "$name@$version" version --prefer-online 2> /dev/null)" = "$version" ]; }
wait_served() { node "$here/served.mjs" wait --name "$name" --version "$version" --integrity "$integrity" "${waits[@]}"; }
if listed; then
  echo "npm already lists $name@$version"
  wait_served
  exit
fi
for attempt in 1 2 3; do
  if npm publish --provenance --access public 2>&1 | tee "${RUNNER_TEMP:-/tmp}/publish-$attempt.log"; then
    wait_served
    exit
  fi
  if listed; then
    wait_served
    exit
  fi
  echo "npm publish failed (attempt $attempt)"
  sleep $((attempt * ${PUBLISH_BACKOFF:-30}))
done
echo "::error::$TAG is tagged but not on npm. Re-run this workflow on main: it publishes the tag at HEAD if npm doesn't have it."
exit 1
