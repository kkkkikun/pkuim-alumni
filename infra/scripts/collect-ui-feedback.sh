#!/usr/bin/env bash
# =============================================================================
# 收集真机体验反馈（截图 / 录屏 / 说明）。
#
# 用途：解决「问题不好用文字描述」的转达成本 —— 用户不必写成需求文档，
#       只需把截图/录屏丢进目录，本脚本负责清点、归类、给出上下文。
#
# 投递目录：debug/user-feedback/（已被 .gitignore 忽略，不会进版本库）
# 用法：
#   bash infra/scripts/collect-ui-feedback.sh list        # 列出全部反馈
#   bash infra/scripts/collect-ui-feedback.sh newest 5    # 列出最近 5 条（待处理）
#   bash infra/scripts/collect-ui-feedback.sh mark        # 把已处理的移入 archive/
#   bash infra/scripts/collect-ui-feedback.sh pack        # 打一个 zip，方便整体传阅
#
# 文件名建议（非强制）：<序号>_<页面>_<一句话>.png
#   例：01_home_塔楼插画被裁切.png
#   不按规范命名也能用 —— 排查时会直接看图，不依赖文件名。
# =============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
INBOX="${PROJECT_ROOT}/debug/user-feedback"
ARCHIVE="${INBOX}/.archive"

# 允许的反馈载体
MEDIA_EXT="png|jpg|jpeg|webp|gif|mp4|mov|txt|md"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

mkdir -p "$INBOX"

list_all() {
  find "$INBOX" -maxdepth 1 -type f -regextype posix-extended \
    -regex ".*\.($MEDIA_EXT)$" -printf '%T@\t%f\n' 2>/dev/null \
    | sort -n | cut -f2-
}

case "${1:-list}" in
  list)
    log "反馈收件箱：${INBOX}"
    COUNT=0
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      COUNT=$((COUNT + 1))
      SIZE=$(stat -c%s "${INBOX}/${f}" 2>/dev/null || echo 0)
      MTIME=$(stat -c%y "${INBOX}/${f}" 2>/dev/null | cut -d. -f1)
      printf '  %2d) %-52s %8s  %s\n' "$COUNT" "$f" "$SIZE" "$MTIME"
    done < <(list_all)
    log "共 ${COUNT} 条"
    if [ "$COUNT" -eq 0 ]; then
      log "（还没有反馈。把截图/录屏直接放进这个目录即可。）"
    fi
    ;;

  newest)
    N="${2:-5}"
    log "最近 ${N} 条（待处理）——按文件名逐个 read 即可："
    list_all | tail -n "$N" | while IFS= read -r f; do
      [ -z "$f" ] && continue
      printf '  %s\n' "${INBOX}/${f}"
    done
    ;;

  mark)
    mkdir -p "$ARCHIVE"
    n=0
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      mv "${INBOX}/${f}" "${ARCHIVE}/${f}"
      n=$((n + 1))
    done < <(list_all)
    log "已归档 ${n} 条 → ${ARCHIVE}"
    ;;

  pack)
    OUT="${PROJECT_ROOT}/debug/ui-feedback-pack-$(date +%Y%m%d-%H%M%S).zip"
    ( cd "$INBOX" && zip -qr "$OUT" . -x '.archive/*' )
    log "已打包：${OUT}"
    ;;

  *)
    echo "用法：$0 {list|newest [N]|mark|pack}" >&2
    exit 1
    ;;
esac
