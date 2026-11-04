#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --locked -j 4
npm --prefix web ci
npm --prefix web run build
