#!/usr/bin/env bash
# Deploys one commit of main on the Oracle VM: fast-forwards this checkout to it and rebuilds the
# containers. GitHub Actions runs it over SSH once CI passed (.github/workflows/deploy-oracle.yml).
#
# It is the forced command of the deploy key in ~/.ssh/authorized_keys (README "Oracle VM 자동 배포"),
# so that key can do nothing else. The commit arrives as the SSH command line:
#   ssh <user>@<host> <40-character sha>   ->   SSH_ORIGINAL_COMMAND=<sha>
# By hand on the VM:  bash scripts/deploy-oracle.sh "$(git rev-parse origin/main)"   (after git fetch)
#
# The whole script runs from main() and exits on the same line, so bash never reads this file again
# after the fast-forward below has replaced it.
set -euo pipefail

main() {
  local sha="${1:-${SSH_ORIGINAL_COMMAND:-}}"
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "usage: deploy-oracle.sh <40-character commit sha>" >&2
    return 2
  fi

  cd "$(dirname "$(readlink -f "$0")")/.."

  # One deploy at a time: a newer push can arrive while the previous build still runs.
  exec 9>"${TMPDIR:-/tmp}/drop6-deploy.lock"
  flock 9

  git fetch --quiet origin main
  if ! git merge-base --is-ancestor "$sha" origin/main; then
    echo "refusing $sha: it is not a commit on origin/main" >&2
    return 3
  fi
  # Fast-forward only: a commit older than the deployed one changes nothing, and edits made on the VM
  # stop the deploy instead of being thrown away.
  git checkout --quiet main
  git merge --quiet --ff-only "$sha"
  echo "deploying $(git rev-parse --short HEAD): $(git log -1 --format=%s)"

  docker compose up -d --build --remove-orphans
  wait_healthy
  docker image prune -f >/dev/null
}

# The image's HEALTHCHECK calls /health; the first check can take up to its 30s interval.
wait_healthy() {
  local id status=missing
  id="$(docker compose ps -q app)"
  for _ in $(seq 1 45); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo missing)"
    if [[ "$status" == healthy ]]; then
      echo "app is healthy"
      return 0
    fi
    sleep 2
  done
  echo "app did not become healthy (last status: $status)" >&2
  docker compose logs --tail 50 app >&2
  return 1
}

main "$@"; exit $?
