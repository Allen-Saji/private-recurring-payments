#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
node --test api/server.test.mjs
node --check agent/renew.mjs
node --check agent/mcp.mjs
node --check supplier/server.mjs
npm audit --prefix agent --omit=dev
