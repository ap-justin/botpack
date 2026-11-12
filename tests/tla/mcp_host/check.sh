#!/bin/sh
# Model-check the lia MCP host models (src/core/mcp_host/,
# src/core/app/app_mcp_runtime.zig) with TLC.
#
# catalog.json lists each model's smoke and stress configs, its planted bugs
# (<Module>.mutants.json), and its findings configs: properties stated for
# users that the model of the code is known to break. ../drivers/mcp_host/model.ts
# runs them all and requires each verdict. Pass --model <Module> to run one.
#
# The tests that drive the real lia binary and have TLC check each trace:
#   bun test ../drivers/mcp_host/
#
# Needs Java 11+, Bun, and tla2tools.jar, as ../README.md describes.
set -eu

cd "$(dirname "$0")"
# A new private folder per run, so nothing planted in the temp folder can
# redirect the gate's output.
out="$(mktemp -d "${TMPDIR:-/tmp}/lia-tla-mcp_host.XXXXXX")"
exec bun ../drivers/mcp_host/model.ts "$out" "$@"
