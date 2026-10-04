#!/bin/bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$repo_dir/.build/locked-use"
clang -Wall -Wextra -Werror -I "$repo_dir/locked-use/Support/include" \
  "$repo_dir/locked-use/AuthorizationPlugin.c" \
  "$repo_dir/locked-use/tests/AuthorizationPluginTests.c" \
  -framework Security -o "$repo_dir/.build/locked-use/test-authorization-plugin"
"$repo_dir/.build/locked-use/test-authorization-plugin"
