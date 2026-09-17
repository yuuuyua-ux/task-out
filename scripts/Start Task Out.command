#!/bin/zsh
set -u
SCRIPT_DIR="${0:A:h}"
# Finder's PATH can differ from the terminal. Use standard installation paths
# and the user's chosen TASK_OUT_NODE; never embed a developer's home directory.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
TASK_OUT_NODE_BIN="${TASK_OUT_NODE:-node}"
if [[ -z "${TASK_OUT_NODE:-}" ]] && ! command -v "$TASK_OUT_NODE_BIN" >/dev/null 2>&1; then
  TASK_OUT_NODE_BIN="$(/bin/zsh -lc 'command -v node' 2>/dev/null)"
fi
if ! command -v "$TASK_OUT_NODE_BIN" >/dev/null 2>&1; then
  print '未找到 Node.js。请从 https://nodejs.org/ 安装 Node.js 24（至少 24.12.0，低于 25）。'
  print '如已安装，可设置 TASK_OUT_NODE 为 Node 可执行文件的完整路径。'
  read '?按回车关闭…'
  exit 1
fi
TASK_OUT_NODE_SUPPORTED="$("$TASK_OUT_NODE_BIN" -p '(() => { const [major, minor] = process.versions.node.split(".").map(Number); return major === 24 && minor >= 12; })()' 2>/dev/null)"
if [[ "$TASK_OUT_NODE_SUPPORTED" != "true" ]]; then
  print 'Task Out 需要 Node.js 24（至少 24.12.0，低于 25），请从 https://nodejs.org/ 安装对应版本。'
  read '?按回车关闭…'
  exit 1
fi
"$TASK_OUT_NODE_BIN" "$SCRIPT_DIR/start.mjs" "$@"
TASK_OUT_EXIT_CODE=$?
if [[ "$TASK_OUT_EXIT_CODE" -ne 0 ]]; then
  read '?启动未完成，按回车关闭…'
elif [[ -t 0 ]]; then
  # Keep pairing details visible when Terminal closes successful commands.
  # This shell can be closed independently of the detached service process.
  read '?请复制所需连接信息，按回车关闭此窗口…'
fi
exit "$TASK_OUT_EXIT_CODE"
