#!/usr/bin/env bash
# Decide which of CI's long model checks a change needs.
#
# Usage: detect-ci-need.sh <base-revision> <head-revision>
#
# mcp: the TLA+ MCP models and drivers job model-checks tests/tla/mcp/ and
# tests/tla/mcp_host/ and drives the MCP engine and lia along them, which takes
# about 20 minutes. A pull request runs it only when it touches src/mcp/,
# src/core/mcp_host/, src/core/mcp/, those models, their drivers in
# tests/tla/drivers/mcp/, tests/tla/drivers/mcp_host/, and
# tests/tla/drivers/lib/, the MCP fixtures in tests/e2e/fixtures/, or the
# helpers the drivers load: tests/e2e/fake-gateway.ts and
# tests/evals/eval-helpers.ts.
#
# It also runs when the change touches build.zig, build.zig.zon,
# .github/workflows/ci.yml, or this script. A change to shared code the check
# also runs, such as the agent loop, is checked by the run on main. Set
# CI_NEED_REQUESTED to a reason to force the check.
#
# Writes mcp, true or false, to
# $GITHUB_OUTPUT and the reasons to $GITHUB_STEP_SUMMARY when those files are
# set. Exits non-zero when either revision cannot be read, so the check fails
# instead of passing without having looked at the change.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  printf 'usage: %s <base-revision> <head-revision>\n' "$0" >&2
  exit 2
fi

base="$1"
head="$2"

mcp=false
mcp_reasons=()

require_mcp() {
  mcp=true
  mcp_reasons+=("$1")
}

for revision in "$base" "$head"; do
  if ! git rev-parse --verify --quiet "$revision^{commit}" >/dev/null; then
    printf 'error: cannot read revision %s; CI cannot decide which checks to run\n' "$revision" >&2
    exit 1
  fi
done

if ! changed_files="$(git diff --name-only --no-renames "$base" "$head")"; then
  printf 'error: git diff %s %s failed; CI cannot decide which checks to run\n' "$base" "$head" >&2
  exit 1
fi

if [ -n "${CI_NEED_REQUESTED:-}" ]; then
  require_mcp "$CI_NEED_REQUESTED"
fi

while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    .github/workflows/ci.yml | scripts/detect-ci-need.sh)
      require_mcp "$path: the checks changed" ;;
    build.zig | build.zig.zon)
      require_mcp "$path: build configuration changed" ;;
    tests/tla/drivers/mcp/* | tests/tla/drivers/mcp_host/*)
      require_mcp "$path: MCP driver changed" ;;
    tests/tla/drivers/lib/*)
      require_mcp "$path: shared driver code changed" ;;
    src/mcp/* | src/core/mcp_host/* | src/core/mcp/*)
      require_mcp "$path: MCP code changed" ;;
    tests/tla/mcp/* | tests/tla/mcp_host/*)
      require_mcp "$path: MCP model changed" ;;
    tests/e2e/fixtures/mcp-* | tests/e2e/fake-gateway.ts | tests/evals/eval-helpers.ts)
      require_mcp "$path: a file the MCP drivers load changed" ;;
  esac
done <<<"$changed_files"

# Prints whether one check runs, and why. The reasons follow the name and
# whether it is needed.
report() {
  local name="$1" needed="$2"
  shift 2
  if [ "$needed" = true ]; then
    printf '%s check needed:\n' "$name"
    printf '  %s\n' "$@"
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      {
        printf '### %s check runs\n\n' "$name"
        printf -- '- %s\n' "$@"
        printf '\n'
      } >>"$GITHUB_STEP_SUMMARY"
    fi
  else
    printf 'No %s change; the %s check runs on main.\n' "$name" "$name"
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      printf 'No %s change; the %s check runs on main.\n\n' "$name" "$name" >>"$GITHUB_STEP_SUMMARY"
    fi
  fi
}

# The ${array[@]+...} form keeps an empty array from tripping set -u in bash
# 3.2, which macOS ships.
report MCP "$mcp" ${mcp_reasons[@]+"${mcp_reasons[@]}"}

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    printf 'mcp=%s\n' "$mcp"
  } >>"$GITHUB_OUTPUT"
fi
