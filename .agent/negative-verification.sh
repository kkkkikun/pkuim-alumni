#!/usr/bin/env bash
# 负向验证（第六轮起的临时脚本 → 第七轮起改为**门禁**的薄封装）。
#
# ⚠️ 为什么还留着这个脚本：
#   第六轮时负向验证靠「临时改代码 + 手动跑」，靠人记得执行；
#   第七轮把它做成了**可重复、可在 CI 里跑**的门禁：
#   `infra/scripts/check-invalidation-bus-selftest.sh`
#   （CI 的「Invalidation bus negative verification」步骤跑的就是它）。
#   本脚本保留下来只是为了**本地手动跑同一条路径**（参数、环境变量完全一致），
#   避免出现「本地一套、CI 另一套」的两份实现。
#
# 门禁做四件事：
#   1. 基线（不改代码）必须全绿；
#   2. 把总线改成「永不订阅 / 永不发布 / 发布时抛错」三种退化形态，
#      断言**守它的那条用例必须变红**；
#   3. 退出时把实现原样还原（字节级校验）；
#   4. 变异锚点对不上（实现被改写）时直接失败 —— 绝不静默跳过。
#
# 用法：bash .agent/negative-verification.sh
set -u
cd "$(dirname "$0")/.."
exec bash infra/scripts/check-invalidation-bus-selftest.sh "$@"
