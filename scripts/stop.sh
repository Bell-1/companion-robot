#!/usr/bin/env bash
# 停止本地开发进程：先让 turbo / vite / tsx watch 退出，再兜底清理占用端口的进程。
set +e

root="$(cd "$(dirname "$0")/.." && pwd)"

pkill -f "$root.*turbo run dev"
pkill -f "$root.*vite"
pkill -f "$root.*tsx watch"

# 兜底：按端口强杀（8787 后端、5173 前端）
for port in 8787 5173; do
  pids="$(lsof -ti "tcp:$port")"
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null
  fi
done

sleep 1

if pgrep -fl "$root.*(turbo|vite|tsx)" >/dev/null 2>&1; then
  echo "仍有进程占用，强制结束"
  pkill -9 -f "$root.*turbo"
  pkill -9 -f "$root.*vite"
  pkill -9 -f "$root.*tsx"
fi

echo "已停止本地开发进程"
exit 0
