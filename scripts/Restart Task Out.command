#!/bin/zsh
set -u
SCRIPT_DIR="${0:A:h}"
# Reuse the same Node discovery and environment checks as the normal launcher.
exec "$SCRIPT_DIR/Start Task Out.command" --restart
