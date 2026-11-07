#!/bin/sh
# Model-check TurnStream and require each config's expected verdict.
#
# TurnStream models how an agent turn streams into the session log and
# commits, and how each tool result keeps the time it was made.
# stream-holds.cfg must pass with every edge case on: results that lost their
# stamp, compaction, recovery from a checkpoint, and faults. stream-before-
# safe.cfg must pass for fx before results kept their stamps, and
# stream-before-reparses.cfg shows that design reparsed streamed pieces. Each
# stream-mutant-*.cfg plants one bug that its property must catch, and each
# stream-witness-*.cfg must be violated. stream-simulate*.cfg run random
# behaviors with more calls and rebuilds.
#
# Run the real binary along the model and have TLC check every run:
#   bun test ../drivers/session/stream.test.ts
#
# Needs Java 11+ and tla2tools.jar, as ../README.md describes.
set -eu

cd "$(dirname "$0")"
# shellcheck source=../lib/tlc.sh
. ../lib/tlc.sh

sim="-simulate num=${SIM_RUNS:-20000} -depth 40 -seed 1"
tlc_verdicts "$@" <<EOF
TurnStream stream-holds -
TurnStream stream-before-safe -
TurnStream stream-before-reparses NoReparseOfStamped
TurnStream stream-mutant-lose-on-recover StampIsBirth
TurnStream stream-mutant-share-stamp StampIsOwn
TurnStream stream-mutant-bytes-only SupersedeExplained
TurnStream stream-mutant-loose-compare CommitIsFinal
TurnStream stream-mutant-mix CommitIsFinal
TurnStream stream-mutant-prefix-only CommitIsFinal
TurnStream stream-witness-supersede NeverSuperseded
TurnStream stream-witness-commit NeverCommittedWhole
TurnStream stream-witness-compaction NeverCommittedAfterCut
TurnStream stream-witness-recovery NeverCommittedAfterRecovery
TurnStream stream-witness-missed-path MissedPathsNeverParse
TurnStream stream-simulate simulate $sim
TurnStream stream-simulate-before simulate $sim
EOF
