#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 小程序离线演示兜底层校验（第 15 层校验）
#
#   bash infra/scripts/check-miniprogram-demo.sh                 # 校验
#   bash infra/scripts/check-miniprogram-demo.sh --root <dir>    # 校验指定副本
#   bash infra/scripts/check-miniprogram-demo.sh --require-typecheck  # 缺 tsc 时也判失败
#
# 背景：
#   这台后端服务器在 NAT 后、没有公网 IP，校园网又屏蔽了大部分免费内网穿透。
#   为了让客户能当场体验小程序，小程序内置了一份**离线演示数据**
#   （`apps/miniprogram/src/demo/**`）：API 不可达时自动回退到本地数据，
#   公网服务器就位后把 `config.DATA_MODE` 改成 'live' 即可切回真实接口。
#
#   这份「兜底层」一旦腐化，症状是**静默**的：演示数据悄悄过期、隐私字段
#   混进分发包里、4xx 被假数据盖住…… 所以它必须有一层可执行的对账。
#
# 七条规则：
#   R1 路由覆盖（失败）：`src/demo/router.ts` 必须覆盖约定的端点清单
#      （方法 + 路径成对出现，缺一个都算不覆盖）。
#   R2 模式开关（失败）：`config/index.ts` 必须有 `DATA_MODE`，取值只能是
#      live / demo / auto。
#   R3 隐私红线（失败）：`src/demo/dataset.data.ts`（以及虚构名录文件）里
#      **不得出现** contactPhone / contactWechat / contactEmail / realName /
#      private_contacts 任一字段名 —— 小程序包是要分发出去的。
#   R4 回退边界（失败）：`services/request.ts` 的回退分支**必须**绑定网络错误
#      判定（NETWORK_ERROR）；**不得**由 HTTP 状态码（4xx/5xx）触发回退
#      —— 4xx/5xx 是服务端真实业务响应，回退会用假数据把真实缺陷盖住。
#   R5 演示分支无网络调用（失败）：`services/auth.ts` 的演示分支里
#      **不得**出现 wx.request / wx.login / post( 等网络调用。
#   R6 类型检查（失败）：`apps/miniprogram` 的 `tsc --noEmit` 必须通过。
#   R7 无运行时 JSON 模块（失败）：源码里**不得**出现 `from '*.json'` /
#      `require('*.json')` —— 微信小程序运行时对 JSON 模块的支持不确定，
#      演示数据必须在编译期内联成 TS 对象字面量。
#
# 反向验证：见 `check-miniprogram-demo-selftest.sh`（逐条注入缺陷证明会红）。
#
# 安全约束：**只读** —— 本脚本不写任何业务文件、不发任何网络请求。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

ROOT="${PROJECT_ROOT}"
REQUIRE_TYPECHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; [ -n "$ROOT" ] || die "--root 需要一个值"; shift 2 ;;
    --require-typecheck) REQUIRE_TYPECHECK=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

APP_DIR="${ROOT}/apps/miniprogram"
DEMO_DIR="${APP_DIR}/src/demo"
ROUTER_TS="${DEMO_DIR}/router.ts"
DATASET_DATA_TS="${DEMO_DIR}/dataset.data.ts"
DIRECTORY_TS="${DEMO_DIR}/directory.ts"
CONFIG_TS="${APP_DIR}/src/config/index.ts"
REQUEST_TS="${APP_DIR}/src/services/request.ts"
AUTH_TS="${APP_DIR}/src/services/auth.ts"
TSCONFIG="${APP_DIR}/tsconfig.json"

require_cmd node
[ -f "$ROUTER_TS" ] || die "演示路由不存在：${ROUTER_TS}"
[ -f "$DATASET_DATA_TS" ] || die "演示数据集不存在：${DATASET_DATA_TS}"
[ -f "$CONFIG_TS" ] || die "配置文件不存在：${CONFIG_TS}"
[ -f "$REQUEST_TS" ] || die "请求层不存在：${REQUEST_TS}"
[ -f "$AUTH_TS" ] || die "认证层不存在：${AUTH_TS}"

FAILED=0

log "=== 小程序离线演示兜底层校验 ==="
log "校验根目录：${ROOT}"

# --- R1：路由覆盖 ---------------------------------------------------------
log "--- R1：演示路由覆盖 ---"
R1_OUT="$(node - "$ROUTER_TS" <<'NODE'
const fs = require('node:fs');

const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');

// 路由表里的每个条目形如： method: 'GET', \n pattern: '/events/:id',
const pairs = new Set();
const pairRe = /method:\s*'([A-Z]+)'\s*,\s*pattern:\s*'([^']+)'/g;
let match = pairRe.exec(src);
while (match) {
  pairs.add(`${match[1]} ${match[2]}`);
  match = pairRe.exec(src);
}

const REQUIRED = [
  'POST /auth/mock/login',
  'GET /auth/session',
  'POST /auth/logout',
  'GET /me',
  'GET /me/profile',
  'GET /me/privacy',
  'GET /me/contacts',
  'GET /me/connections',
  'GET /me/connection-requests',
  'GET /me/resources',
  'GET /me/events',
  'GET /me/verifications',
  'GET /me/notifications',
  'GET /events',
  'GET /events/:id',
  'POST /events/:id/registrations',
  'GET /articles',
  'GET /articles/:id',
  'GET /articles/categories',
  'GET /notices',
  'GET /notices/:id',
  'GET /directory',
  'GET /directory/:id',
  'GET /resources',
  'GET /resources/:id',
  'GET /connections',
  'GET /connections/requests',
  'GET /connections/requests/:id',
  'GET /connections/:id',
  'GET /system/regions',
  'GET /system/industries',
  'GET /notifications/unread-count',
  'POST /notifications/read-all',
  'POST /notifications/:id/read',
  'GET /uploads',
  'GET /uploads/records',
  'GET /alumni/verification/mine',
];

const missing = REQUIRED.filter((item) => !pairs.has(item));
if (missing.length) {
  missing.forEach((item) => console.log(`MISSING\t${item}`));
  process.exit(1);
}
console.log(`OK\t${REQUIRED.length}`);
NODE
)" && R1_OK=1 || R1_OK=0
if [ "$R1_OK" -eq 1 ]; then
  log "  ✓ R1：演示路由覆盖了约定的全部端点（$(printf '%s' "$R1_OUT" | tail -1 | awk -F'\t' '{print $2}') 个）"
else
  warn "  ✗ [DEMO_ROUTE_MISSING] 演示路由未覆盖下列端点："
  printf '%s\n' "$R1_OUT" | grep '^MISSING' | sed 's/^MISSING\t/      - /' >&2
  FAILED=1
fi

# --- R2：数据模式开关 -----------------------------------------------------
log "--- R2：数据模式开关 ---"
R2_OUT="$(node - "$CONFIG_TS" <<'NODE'
const fs = require('node:fs');

const src = fs.readFileSync(process.argv[2], 'utf8');
const typeRe = /export\s+type\s+DataMode\s*=\s*([^;]+);/;
const valueRe = /export\s+const\s+DATA_MODE\s*:\s*DataMode\s*=\s*'([^']+)'/;

const typeMatch = typeRe.exec(src);
const valueMatch = valueRe.exec(src);
if (!typeMatch) {
  console.log('NO_TYPE\texport type DataMode = ... 缺失');
  process.exit(1);
}
if (!valueMatch) {
  console.log('NO_VALUE\texport const DATA_MODE: DataMode = ... 缺失');
  process.exit(1);
}
const allowed = ['live', 'demo', 'auto'];
const value = valueMatch[1];
if (!allowed.includes(value)) {
  console.log(`BAD_VALUE\tDATA_MODE 取值非法：${value}（允许 ${allowed.join(' / ')}）`);
  process.exit(1);
}
const declared = typeMatch[1];
const missing = allowed.filter((item) => !declared.includes(`'${item}'`));
if (missing.length) {
  console.log(`BAD_TYPE\tDataMode 类型缺少取值：${missing.join(' / ')}`);
  process.exit(1);
}
console.log(`OK\t${value}`);
NODE
)" && R2_OK=1 || R2_OK=0
if [ "$R2_OK" -eq 1 ]; then
  log "  ✓ R2：DATA_MODE 存在且取值合法（当前 $(printf '%s' "$R2_OUT" | tail -1 | awk -F'\t' '{print $2}')）"
else
  warn "  ✗ [DEMO_DATA_MODE_INVALID] $(printf '%s\n' "$R2_OUT" | tail -1 | tr '\t' ' ')"
  FAILED=1
fi

# --- R3：隐私红线 ---------------------------------------------------------
log "--- R3：演示数据不得含联系方式字段 ---"
FORBIDDEN_FIELDS="contactPhone contactWechat contactEmail realName private_contacts"
R3_BAD=0
for file in "$DATASET_DATA_TS" "$DIRECTORY_TS"; do
  [ -f "$file" ] || continue
  for field in $FORBIDDEN_FIELDS; do
    if grep -q "$field" "$file"; then
      warn "  ✗ [DEMO_PII_FIELD] $(basename "$file") 里出现了敏感字段名：${field}"
      R3_BAD=1
    fi
  done
done
if [ "$R3_BAD" -eq 0 ]; then
  log "  ✓ R3：演示数据集与虚构名录均不含任何联系方式 / 实名字段"
else
  FAILED=1
fi

# --- R7：运行时不得 import .json -------------------------------------------
# 微信小程序运行时对 `require('*.json')` 的支持不确定；
# 数据必须在**编译期**内联成 TS 对象字面量，不能在运行时去 load JSON。
#
# ⚠️ 必须先剥掉注释再判定 —— 注释里提到「require('*.json')」是**说明**，
#    不是真的运行时引用（第一版就误报过，教训记在这里）。
log "--- R7：运行时不得依赖 JSON 模块 ---"
R7_OUT="$(node - "${APP_DIR}/src" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
const problems = [];

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walk(full);
    } else if (name.endsWith('.ts')) {
      check(full);
    }
  }
}

function check(file) {
  const raw = fs.readFileSync(file, 'utf8');
  // 去掉行注释与块注释（保留换行，避免行号错位）
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
  const patterns = [
    /from\s*['"][^'"]+\.json['"]/g,
    /require\s*\(\s*['"][^'"]+\.json['"]\s*\)/g,
    /import\s*\(\s*['"][^'"]+\.json['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(code)) !== null) {
      const line = code.slice(0, m.index).split('\n').length;
      problems.push(`${file}:${line}\t${m[0]}`);
    }
  }
}

walk(root);
if (problems.length) {
  for (const p of problems) console.log('PROBLEM\t' + p);
  process.exit(1);
}
NODE
)" && R7_OK=1 || R7_OK=0
if [ "$R7_OK" -eq 1 ]; then
  log "  ✓ R7：源码里没有运行时 JSON 模块引用（数据已编译期内联）"
else
  printf '%s\n' "$R7_OUT" | grep '^PROBLEM' | sed 's/^PROBLEM\t/  ✗ [DEMO_JSON_IMPORT] /' >&2
  FAILED=1
fi

# --- R4：回退边界（只允许网络层失败回退） ---------------------------------
log "--- R4：回退边界（仅网络错误可回退）---"
R4_OUT="$(node - "$REQUEST_TS" <<'NODE'
const fs = require('node:fs');

const src = fs.readFileSync(process.argv[2], 'utf8');
const lines = src.split(/\r?\n/);

/** 取某个 if 行的条件文本（括号可跨行） */
function conditionOf(start) {
  let text = '';
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    text += (i === start ? '' : ' ') + line;
    for (const ch of line) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    if (depth <= 0 && text.indexOf('(') >= 0) break;
  }
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  return open >= 0 && close > open ? text.slice(open + 1, close) : '';
}

const problems = [];
let fallbackSites = 0;

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (!/callDemo\s*[<(]/.test(line)) continue;
  if (/function\s+callDemo/.test(line)) continue;
  fallbackSites += 1;

  // 向上找最近的一层 if 守卫
  let guard = -1;
  for (let j = i - 1; j >= 0; j -= 1) {
    if (/\bif\s*\(/.test(lines[j])) {
      guard = j;
      break;
    }
  }
  if (guard < 0) {
    problems.push(`第 ${i + 1} 行的演示回退调用没有任何守卫条件`);
    continue;
  }
  const cond = conditionOf(guard);
  const isNetworkGuard = cond.indexOf('NETWORK_ERROR') >= 0;
  const isDemoModeGuard = cond.indexOf('DATA_MODE') >= 0 && /demo/.test(cond);
  if (!isNetworkGuard && !isDemoModeGuard) {
    problems.push(`第 ${i + 1} 行的演示回退调用没有绑定网络错误判定（守卫：${cond.trim()}）`);
  }
  if (/statusCode|HTTP_|>= *400|>= *500/.test(cond)) {
    problems.push(`第 ${i + 1} 行的演示回退由 HTTP 状态码触发（守卫：${cond.trim()}）`);
  }
}

if (fallbackSites === 0) {
  problems.push('请求层里找不到任何演示回退调用（callDemo）');
}
if (src.indexOf('NETWORK_ERROR') < 0) {
  problems.push('请求层里没有 NETWORK_ERROR 判定');
}

if (problems.length) {
  problems.forEach((item) => console.log(`PROBLEM\t${item}`));
  process.exit(1);
}
console.log(`OK\t${fallbackSites}`);
NODE
)" && R4_OK=1 || R4_OK=0
if [ "$R4_OK" -eq 1 ]; then
  log "  ✓ R4：回退分支绑定网络错误判定，不对 4xx/5xx 回退"
else
  warn "  ✗ [DEMO_FALLBACK_UNSAFE] 回退边界不安全："
  printf '%s\n' "$R4_OUT" | grep '^PROBLEM' | sed 's/^PROBLEM\t/      - /' >&2
  FAILED=1
fi

# --- R5：演示分支不得含网络调用 -------------------------------------------
log "--- R5：演示分支不得发网络请求 ---"
R5_OUT="$(node - "$AUTH_TS" <<'NODE'
const fs = require('node:fs');

const src = fs.readFileSync(process.argv[2], 'utf8');
const lines = src.split(/\r?\n/);

const NETWORK_CALL = /wx\.(request|login|uploadFile)\b|\b(post|get|put|patch|del)\s*[(<]/;

/** 从第 start 行开始，取出花括号块的文本 */
function blockOf(start) {
  let depth = 0;
  let text = '';
  let started = false;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    text += line + '\n';
    for (const ch of line) {
      if (ch === '{') {
        depth += 1;
        started = true;
      } else if (ch === '}') {
        depth -= 1;
      }
    }
    if (started && depth <= 0) break;
  }
  return text;
}

const problems = [];
let guards = 0;

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (!/\bif\s*\(/.test(line)) continue;
  if (!/DATA_MODE/.test(line) || !/demo/.test(line)) continue;
  guards += 1;
  const block = blockOf(i);
  const hit = block.match(NETWORK_CALL);
  if (hit) {
    problems.push(`第 ${i + 1} 行的演示分支里出现了网络调用：${hit[0]}`);
  }
}

if (guards === 0) {
  problems.push('认证层里找不到任何 DATA_MODE 演示分支');
}
if (/wx\.request\s*\(/.test(src)) {
  problems.push('认证层里直接出现了 wx.request 调用');
}

if (problems.length) {
  problems.forEach((item) => console.log(`PROBLEM\t${item}`));
  process.exit(1);
}
console.log(`OK\t${guards}`);
NODE
)" && R5_OK=1 || R5_OK=0
if [ "$R5_OK" -eq 1 ]; then
  log "  ✓ R5：认证层的演示分支不发起任何网络调用"
else
  warn "  ✗ [DEMO_AUTH_NETWORK_CALL] 演示分支含网络调用："
  printf '%s\n' "$R5_OUT" | grep '^PROBLEM' | sed 's/^PROBLEM\t/      - /' >&2
  FAILED=1
fi

# --- R6：类型检查 ---------------------------------------------------------
log "--- R6：TypeScript 类型检查 ---"
TSC_BIN=""
if [ -x "${APP_DIR}/node_modules/.bin/tsc" ]; then
  TSC_BIN="${APP_DIR}/node_modules/.bin/tsc"
elif command -v tsc >/dev/null 2>&1; then
  TSC_BIN="$(command -v tsc)"
fi
if [ -z "$TSC_BIN" ]; then
  if [ "$REQUIRE_TYPECHECK" -eq 1 ]; then
    warn "  ✗ [DEMO_TYPECHECK_MISSING] 找不到 tsc（依赖未安装），无法验证类型检查"
    FAILED=1
  else
    warn "  ! [提示] 找不到 tsc（依赖未安装）→ R6 跳过；装好依赖后重跑，或加 --require-typecheck"
  fi
else
  set +e
  TSC_OUT="$("$TSC_BIN" --noEmit -p "$TSCONFIG" 2>&1)"
  TSC_RC=$?
  set -e
  if [ "$TSC_RC" -ne 0 ]; then
    warn "  ✗ [DEMO_TYPECHECK_FAILED] tsc --noEmit 未通过："
    printf '%s\n' "$TSC_OUT" | tail -20 | sed 's/^/      /' >&2
    FAILED=1
  else
    log "  ✓ R6：tsc --noEmit 通过（${TSC_BIN}）"
  fi
fi

# --- 汇总 -----------------------------------------------------------------
if [ "$FAILED" -ne 0 ]; then
  die "小程序离线演示兜底层校验失败 ❌"
fi
log "=== 小程序离线演示兜底层校验通过 ✅"
