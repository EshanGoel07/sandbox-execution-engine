#!/bin/sh
# Worker entrypoint: make sure the three language sandbox images exist on the
# host daemon (first run builds them, ~1-2 min), then start the pool.
set -e

IMAGES_DIR="${IMAGES_DIR:-apps/worker/images}"

for lang in cpp java python; do
  if ! docker image inspect "judge-$lang" >/dev/null 2>&1; then
    echo "building judge-$lang image..."
    docker build -t "judge-$lang" "$IMAGES_DIR/$lang"
  fi
done

echo "sandbox images ready — starting worker pool"
exec node apps/worker/dist/main.js
