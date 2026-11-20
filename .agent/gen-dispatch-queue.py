#!/usr/bin/env python3
"""生成 pkuim-alumni 的 agent 派活队列文件。

brief 里的每个路径与要求都对着仓库里真实存在的文档与脚本，
不是凭空写的清单；写完用 JSON 解析自检，避免引号/换行把文件弄坏。
"""
import json
import pathlib

BRIEF = """目标：把仓库已记录的安全与性能缺口一次性做完 —— 只要是仓库自身能控的，就不要留到下一轮。本轮结束时，仓库里不应再有「安全或性能上可自行修复却仍未修复」的项。

一、安全（以 docs/SECURITY.md 为准）

1. 逐条核对 docs/SECURITY.md 第 8 节「待办（上线前必须完成）」的五项，按各自性质分开处理：
   - 「正式环境更换 JWT_SECRET、数据库口令、MinIO 密钥，改用密钥管理服务注入」：仓库侧能做的是把这几项的**配置读取与启动期校验**补齐（例如配置缺失时在生产配置下拒绝启动、.env.example 给出占位与生成说明、轮转说明写进文档），**绝不可把真实密钥写进仓库**，也**不得声称已接入密钥管理服务** —— 接入密钥管理服务属人工安排。
   - 「关闭 Mock 登录（AUTH_MODE=wechat）」：核对 AUTH_MODE 在配置、启动校验与客户端登录路径上是否真的收敛。仓库能控的是「非 wechat 模式下 mock 登录路径不可用」这一侧，把校验与用例补齐；正式 AppID/AppSecret 的填写属人工安排。
   - 「CORS 收敛到正式域名，启用 HTTPS 证书」：核对 CORS 白名单是否只接受配置里列出的正式域名（不接受通配符、不接受任意 Origin），补正向与负向用例；证书签发属人工安排。
   - 「接入微信订阅消息模板（Outbox 通道已预留）」：仓库侧只做**通道的契约、重试、幂等、失败不丢消息**的代码与用例；模板 ID 与真实推送属人工安排。
   - 「补充安全响应头与 WAF 规则、按 top.md §11 建立定期备份与恢复演练」：安全响应头属仓库可控（infra/nginx 与应用层都要覆盖），照 top.md §11 落地；WAF 规则属人工安排。
2. 复核 docs/SECURITY.md 第 3 节（隐私与联系方式，最高优先级）、第 4 节（输入与注入）、第 5 节（传输与暴露面）、第 6 节（频率与滥用）、第 7 节（审计）里只在文字上承诺、代码与配置尚未落实的项，逐条补齐并加用例。
3. 文档与实现不一致时，以更严格的一侧为准：代码按文档收紧，文档按代码补证；**不允许靠改文档把差距消掉**。

二、性能（以实测为准，不靠猜）

1. 后端 apps/api：逐条检查 N+1 查询（列表接口的关联加载）、缺失索引（对照 docs/DATABASE-DESIGN.md 的实体与查询条件）、分页缺失或无上限、热点无缓存、事务粒度过大、连接池配置（对照 docs/CONCURRENCY-DESIGN.md）。
2. 小程序 apps/miniprogram：首屏请求数与包体积、重复请求、轮询频率、图片与静态资源体积、未分页列表。
3. 管理端 apps/admin-web：产物体积、请求并发、表格与列表的渲染量。
4. 每项性能改动都必须给出**改动前后的实测数字**（同一数据集、同一命令）。没有实测数字的性能结论不算完成；确实无法在本地复现的，写明为什么无法复现，并记为待验证项，**不得声称已优化**。

三、已记录的其它缺口

docs/KNOWN-ISSUES.md 中状态为未解决或待办的条目、docs/SELF-CHECK-AND-SCHEDULE.md 第二节问题清单里状态非 ✅ 的条目、docs/TEST-REPORT.md 里标红的项：能自行修复的一并做掉。

四、边界（不得越界）

- 不得引入真实密钥、真实个人信息或真实客户数据；不得提交 .env 或任何凭据。
- 不得为了通过检查而放宽校验、删用例、降门禁阈值、关掉 lint 或类型检查。
- 不得改动业务规则与对外接口语义（新增字段可以，删除或改语义不行；契约变更须同步 docs/API-SPEC.md 与 packages/contracts）。
- 不得做与「安全 / 性能」无关的重构、UI 改版或新功能。
- 依赖升级只在能消除已知高危或带来明确性能收益时做，且必须逐条说明理由与实测影响。

五、验证

- pnpm typecheck / pnpm lint / pnpm test 退出码全部为 0；每处改动都要有对应用例。
- 涉及数据库结构的改动走 TypeORM migration，不得直接改表。
- 安全类改动要有**负向验证**：证明攻击面确实被挡住（越权/注入/未授权路径返回 401 或 403），不是只写正向用例。
- 性能类改动要有前后对比数字。
- 把实测命令、日期、环境与结果写进 docs/TEST-REPORT.md（性能部分）与 docs/SECURITY.md（安全部分），不另起新文档。

六、结束条件

本轮结束时，仓库里不应再有可自行修复的安全或性能项。剩余确实需要人工动作、真实密钥、客户确认、备案或生产环境的项，逐条写进 docs/KNOWN-ISSUES.md 的待办小节，写明为什么本轮做不了、还需要谁做什么，**不得把这类项说成已完成**。

七、提交与署名

- 提交身份：LL-ki <267322696+LL-ki@users.noreply.github.com>。
- **禁止任何 Co-Authored-By trailer**，尤其不得出现 DeepSeek Harness、dsh-superagent、任何 bot、模型或 CI 账号。
- 一个 PR 覆盖本轮全部改动；PR 描述写清改了什么、实测数字、以及哪些项留待人工。"""

queue = {
    "current": {
        "id": "opt-001",
        "title": "安全与性能全面自查：按仓库已记录的缺口逐项修复，一轮做完所有可自行修复项",
        "brief": BRIEF,
    },
    "history": [],
}

out = pathlib.Path(__file__).resolve().parent / "dispatch-queue.json"
out.write_text(json.dumps(queue, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

check = json.loads(out.read_text(encoding="utf-8"))
assert check["current"]["id"] == "opt-001"
assert "@LL-ki" not in check["current"]["brief"], "brief 里不该出现 @LL-ki（会触发 agent 自我派活判定）"
print(f"已写入 {out}（{out.stat().st_size} 字节，brief {len(BRIEF)} 字）")
