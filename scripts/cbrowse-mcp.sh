#!/bin/zsh
set -euo pipefail

cd /Users/cozy/Documents/cBrowse
exec ./node_modules/.bin/tsx src/mcp/stdioServer.ts
