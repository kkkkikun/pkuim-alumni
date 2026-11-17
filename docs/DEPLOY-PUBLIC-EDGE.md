# 公网接入层部署指南（临时预览版用）

> 目标：让**客户手机**和**客户浏览器**能访问到本平台的后端 API 与管理后台，
> 从而支撑「微信小程序临时预览版」与「管理后台演示」。
>
> 现状约束（已实测）：校园机 `172.16.38.110` 在 NAT 后面、无公网 IP，
> compose 的 nginx 绑在 `127.0.0.1:18080`，校园网只放行了极少数站点
> （GitHub / ngrok / cloudflare / localhost.run 等免费穿透服务均不可达）。
> 所以走「**临时公网服务器 + SSH 反向隧道**」这条路。

---

## 一、需要什么配置的服务器

### 1.1 结论先行

| 用途 | 配置 | 说明 |
|---|---|---|
| **只做公网入口**（推荐，最快上线） | **1 核 / 1 GB / 20 GB 磁盘** 就够 | 只跑 nginx + 一条 SSH 隧道，内存实测占用 < 200 MB |
| 想顺便把整套系统搬上去 | **2 核 / 2 GB / 40 GB 磁盘** | 能吃下 MySQL + Redis + NestJS + Nginx（推荐给「正式对外」用） |

其它硬性要求：

| 项目 | 要求 |
|---|---|
| 公网 IP | **必须有**（独立 IPv4；带 IPv6 也行，但要确认商家给的 IPv4 是真公网） |
| 操作系统 | Ubuntu 22.04 / 24.04（脚本按 Debian 系写；CentOS 也可，手改 nginx 配置路径即可） |
| 入站端口 | **22**（部署用）、**80**（小程序/浏览器访问）、**443**（启用 HTTPS 时） |
| 出站端口 | 全放行（要能 apt/yum 装 nginx、要能 SSH 回连校园机） |
| 带宽 | 5 Mbps 起步就够；月流量 5 GB 量级绰绰有余（小程序包 ~1–2 MB，接口都是 JSON） |
| 磁盘 | 20 GB 起（只放 nginx + 证书） |
| 域名 | **可选**。体验版阶段用 `http://<公网IP>/api/v1` 即可；正式发布才需要已备案域名 + HTTPS |
| GPU / 大内存 | 不需要 |

### 1.2 安全组 / 防火墙放行清单

```
入站  TCP 22     来源 你的办公 IP（更安全）；临时图省事可先放开
入站  TCP 80     来源 0.0.0.0/0   （客户手机访问）
入站  TCP 443    来源 0.0.0.0/0   （启用 HTTPS 时）
出站  全部       允许
```

### 1.3 两种用法，选择其一

**用法 A：只做公网入口（推荐，改动最小、风险最低）**

```
手机/浏览器 → [公网服务器 nginx] → SSH 反向隧道 → [校园机 compose nginx]
                                                        ├─ /      → 管理后台
                                                        └─ /api/v1 → API
```

- 业务数据库原地不动（users=1202 等数据不变），**不碰现有生产环境**；
- 公网服务器是「临时」资源，到期即拆，校园机侧不受影响；
- 客户体验版小程序 → 真实数据。

**用法 B：整套系统迁到公网服务器**

- 需要把 MySQL 数据迁过去、`.env.prod` 改公网地址、重新跑迁移；
- 适合「临时服务器要长期用」的情况。本仓库的 `infra/scripts/deploy.sh` 已经支持
  「切流量前先跑迁移 → 重建容器 → 发布后对账」，迁移过去改动量可控。

> 建议：**先用 A 跑通客户体验**，等小程序资质和正式域名都到位，再评估 B。

---

## 二、部署步骤（10 分钟）

### 第 0 步：拿到服务器信息后要做的事

请提供：公网 IP、SSH 用户名、端口、登录方式（密码或密钥）。

### 第 1 步：公网服务器上装边缘 nginx

把脚本传到公网服务器（或直接粘贴执行）：

```bash
# 传到公网机
scp infra/scripts/deploy-public-edge.sh root@<公网IP>:/root/
ssh root@<公网IP> 'apt-get update && apt-get install -y nginx && bash /root/deploy-public-edge.sh --listen 80'
```

脚本做的事：写 `/etc/nginx/conf.d/nmg-edge.conf` → `nginx -t` → reload → 自检。
重复执行是幂等的（会先备份旧配置）。

### 第 2 步：校园机上建立反向隧道

```bash
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/tunnel-public-edge.sh \
    --public-host <公网IP> --remote-user root --daemon'
```

脚本会：
1. 在校园机生成隧道专用密钥 `~/.ssh/nmg_edge_key`；
2. **打印公钥** → 把它加到公网机的 `~/.ssh/authorized_keys`；
3. 拉起后台守护进程（断了自动重连，10 秒重试）。

> **端口选择**：默认公网侧监听 `18080`。
> 若与既有服务冲突，用 `--remote-listen-port <端口>` 换一个
> （校园机上 `18081`/`18082` 等端口**已被其它服务占用**，别踩）。
> 停隧道用 `--stop`（会连 ssh 子进程一起收干净，否则端口会一直被占）。

```bash
# 公网机上追加公钥（把上一步打印的整行贴进去）
echo 'ssh-ed25519 AAAA... nmg-edge-tunnel' >> ~/.ssh/authorized_keys
```

### 第 3 步：验收

```bash
# 在公网机上
curl -sS http://127.0.0.1:18080/api/v1/system/health     # 隧道是否通
curl -sS http://127.0.0.1/ -o /dev/null -w '%{http_code}\n'   # 边缘 nginx
# 在你自己电脑上
curl -sS http://<公网IP>/api/v1/system/health
curl -sSI http://<公网IP>/                          # 管理后台首页
```

---

## 三、小程序侧怎么指向这个公网地址

体验版不需要手改代码，发布时用参数注入：

```bash
bash infra/scripts/release-miniprogram-preview.sh \
  --appid wxXXXXXXXXXXXXXXXX \
  --private-key /仓库外路径/private.wxXXXXXXXXXXXXXXXX.key \
  --api-base-url http://<公网IP>/api/v1 \
  --version 0.1.0 --desc "临时预览版"
```

注入是**构建期**行为：脚本改 `src/config/index.ts` → 编译上传 → 自动还原源文件。

### 微信侧的必要开关

体验版 / 开发版默认校验「request 合法域名」，用 `http://IP` 会直接失败。

- **临时做法**：微信公众平台 →「开发管理 → 开发设置 → 服务器域名」→
  勾选 **「不校验合法域名」**（体验版可用）。
- **正式发布**：必须换成**已备案域名 + HTTPS 证书**，并在「服务器域名」里配置。

---

## 四、安全提醒（请一并处理）

1. **管理后台暴露在公网**：`/` 是 Vue3 管理后台（账号 `admin` / `Admin@2026`）。
   演示期间请**改掉默认密码**，演示结束立刻关掉公网入口或加 IP 白名单。
2. **校园机的 SSH 已被转发到公网**（`172.16.38.110:56127`）。请确认：
   - 只用密钥登录（已是无密码 ed25519 免密）；
   - `authorized_keys` 里**不要**放来源不明的公钥；
   - 建议换成 `PasswordAuthentication no`。
3. **不要**把 MySQL / Redis 端口暴露到公网。公网机只装 nginx，隧道只转 HTTP。
4. 演示数据里不含任何联系方式（`private_contacts` 字段在导出时已被剥离）。
5. 临时服务器到期前，把公网入口关掉：`systemctl stop nginx` + 停掉校园机的隧道单元。

---

## 五、脚本索引

| 脚本 | 跑在哪 | 作用 |
|---|---|---|
| `infra/scripts/deploy-public-edge.sh` | 公网服务器 | 装 nginx + 反代到隧道端口（可选 HTTPS） |
| `infra/scripts/tunnel-public-edge.sh` | 校园机 | 建立 SSH 反向隧道（`--daemon` 不需要 root；`--stop` 收干净） |
| `infra/scripts/check-public-edge-e2e.sh` | 校园机 | 端到端自测：边缘 nginx → 隧道 → compose nginx → API |
| `infra/scripts/release-miniprogram-preview.sh` | 校园机 | 一键发布体验版：预检 → 离线编译自检 → 写 AppID → 注入 API 基址 → 上传 → 出二维码 |
| `infra/scripts/miniprogram-ci-upload.sh` | 校园机 | 底层 CI 封装（`--check` / `--preview` / `--upload` / `--write-appid` / `--api-base-url`） |
| `infra/scripts/miniprogram-compile-check.mjs` | 校园机 | **离线**编译自检：不联网也能证明「这份工程能编译出包」 |
| `infra/scripts/export-miniprogram-demo-data.mjs` | 本机或校园机 | 导出小程序离线演示数据集 |

## 六、上线前的自检清单

```bash
# 1. 离线编译自检（证明包能编译出来，且每个源模块都在包里）
node infra/scripts/miniprogram-compile-check.mjs apps/miniprogram

# 2. 离线演示兜底层校验（R1~R7，含隐私红线）
bash infra/scripts/check-miniprogram-demo.sh

# 3. 公网接入链路端到端自测（边缘 → 隧道 → API）
bash infra/scripts/check-public-edge-e2e.sh 38080 38081

# 4. 在公网机上验证对外入口
curl -sS http://127.0.0.1/api/v1/system/health
```

> ⚠️ 第 1 步尤其重要：微信编译器会剪掉「看起来没被引用」的文件，
> 而它**曾经剪错过** —— 把所有页面 `require` 的桶文件剪掉，
> 导致上传成功、客户拿到一打开就崩的包（详见 `docs/KNOWN-ISSUES.md` #145）。
