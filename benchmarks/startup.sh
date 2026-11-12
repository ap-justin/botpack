#!/usr/bin/env bash
#
# Startup latency benchmarks for lia.
#
# Measures wall-clock time for common CLI commands using hyperfine.
# Results are written to benchmarks/results/ in JSON format for CI consumption.
#
# Usage:
#   ./benchmarks/startup.sh              # run all benchmarks
#   ./benchmarks/startup.sh --quick      # fewer iterations (20 runs)
#   ./benchmarks/startup.sh --ci         # CI settings (100 runs, skip build)
#
# Requires: hyperfine (https://github.com/sharkdp/hyperfine)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIA_BIN="${REPO_ROOT}/zig-out/bin/lia"
RESULTS_DIR="${REPO_ROOT}/benchmarks/results"
SESSION_FIXTURE_ROOT="${TMPDIR:-/tmp}/lia-session-list-benchmark-$$"
SESSION_FIXTURE_HOME="${SESSION_FIXTURE_ROOT}/home"
SESSION_FIXTURE_WORKSPACE="${SESSION_FIXTURE_ROOT}/workspace"
GENERAL_FIXTURE_HOME="${SESSION_FIXTURE_ROOT}/general-home"

cleanup() {
  rm -rf "$SESSION_FIXTURE_ROOT"
}
trap cleanup EXIT

if ! command -v hyperfine &>/dev/null; then
  echo "error: hyperfine is not installed"
  echo "       brew install hyperfine  (macOS)"
  echo "       apt install hyperfine   (Debian/Ubuntu)"
  echo "       cargo install hyperfine (Rust/Cargo)"
  exit 1
fi

RUNS=100
WARMUP=10
SKIP_BUILD=false
SHELL_OPTS=(-N)
case "${1:-}" in
  --quick)  RUNS=20;  WARMUP=3 ;;
  --ci)     RUNS=100; WARMUP=10; SKIP_BUILD=true ;;
esac

if [ "$SKIP_BUILD" = false ]; then
  echo "Building lia (ReleaseSafe)..."
  (cd "$REPO_ROOT" && zig build -Doptimize=ReleaseSafe)
fi

if [ ! -x "$LIA_BIN" ]; then
  echo "error: lia binary not found at $LIA_BIN"
  exit 1
fi

mkdir -p "$RESULTS_DIR"
rm -f "${RESULTS_DIR}/tasks.json"
mkdir -p "$SESSION_FIXTURE_HOME" "$SESSION_FIXTURE_WORKSPACE" "$GENERAL_FIXTURE_HOME"
mkdir -p "$GENERAL_FIXTURE_HOME/.lia"
chmod 700 "$GENERAL_FIXTURE_HOME/.lia"
printf '%s\n' \
  '{"model":"openai/gpt-5.4","effort":"high","fast_mode":false,"startup_scrollback":true,"prompt_history":{"enabled":true},"statusLine":{"sandbox":true,"context":true},"permission":{"bash":{"git status *":"allow"}}}' \
  > "$GENERAL_FIXTURE_HOME/.lia/settings.json"
chmod 600 "$GENERAL_FIXTURE_HOME/.lia/settings.json"
python3 "${REPO_ROOT}/benchmarks/session_list_fixture.py" \
  --home "$SESSION_FIXTURE_HOME" \
  --workspace "$SESSION_FIXTURE_WORKSPACE"

if [ -x /usr/bin/true ]; then
  TRUE_BIN=/usr/bin/true
elif [ -x /bin/true ]; then
  TRUE_BIN=/bin/true
else
  TRUE_BIN=true
fi

echo "=== lia startup benchmarks ==="
echo "binary: $LIA_BIN"
echo "runs:   $RUNS (warmup: $WARMUP)"
echo ""

# Baseline: process launch floor on this host. This is reported for context;
# the budget checker still enforces each lia command's raw wall-clock mean.
echo "--- process baseline ---"
HOME="$GENERAL_FIXTURE_HOME" hyperfine \
  "${SHELL_OPTS[@]}" \
  --runs "$RUNS" \
  --warmup "$WARMUP" \
  --export-json "${RESULTS_DIR}/baseline.json" \
  --command-name "process baseline" \
  "$TRUE_BIN"

echo ""

# Benchmark 0: lia startup (CLI dispatch, no TTY needed)
echo "--- lia (startup) ---"
HOME="$GENERAL_FIXTURE_HOME" LIA_BENCH=1 hyperfine \
  "${SHELL_OPTS[@]}" \
  --runs "$RUNS" \
  --warmup "$WARMUP" \
  --export-json "${RESULTS_DIR}/startup.json" \
  --command-name "lia (startup)" \
  "$LIA_BIN"

echo ""

# Benchmark 1: lia help (minimal startup path)
echo "--- lia help ---"
HOME="$GENERAL_FIXTURE_HOME" hyperfine \
  "${SHELL_OPTS[@]}" \
  --runs "$RUNS" \
  --warmup "$WARMUP" \
  --export-json "${RESULTS_DIR}/help.json" \
  --command-name "lia help" \
  "$LIA_BIN help"

echo ""

# Benchmark 2: lia status --json (config load + JSON serialize)
echo "--- lia status --json ---"
HOME="$GENERAL_FIXTURE_HOME" hyperfine \
  "${SHELL_OPTS[@]}" \
  --runs "$RUNS" \
  --warmup "$WARMUP" \
  --export-json "${RESULTS_DIR}/status.json" \
  --command-name "lia status --json" \
  "$LIA_BIN status --json"

echo ""

# Benchmark 3: lia doctor --json (system checks)
echo "--- lia doctor --json ---"
HOME="$GENERAL_FIXTURE_HOME" hyperfine \
  "${SHELL_OPTS[@]}" \
  --runs "$RUNS" \
  --warmup "$WARMUP" \
  --export-json "${RESULTS_DIR}/doctor.json" \
  --command-name "lia doctor --json" \
  "$LIA_BIN doctor --json"

echo ""

# Benchmark 4: lia sessions --json (file I/O path)
echo "--- lia sessions --json ---"
HOME="$SESSION_FIXTURE_HOME" hyperfine \
  "${SHELL_OPTS[@]}" \
  --runs "$RUNS" \
  --warmup "$WARMUP" \
  --export-json "${RESULTS_DIR}/sessions.json" \
  --command-name "lia sessions --json" \
  "$LIA_BIN sessions --json"

echo ""

# Combine results into a single summary for CI
echo "--- summary ---"
python3 "${REPO_ROOT}/benchmarks/summarize.py"
python3 "${REPO_ROOT}/benchmarks/check_budgets.py"
