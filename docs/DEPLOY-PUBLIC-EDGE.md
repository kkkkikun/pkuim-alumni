# 公网接入层部署指南（临时预览版用）

> 目标：让**客户手机**能访问到本平台的后端 API，从而支撑「微信小程序临时预览版」。
>
> 现状约束（已实测）：校园机 `172.16.38.110` 在 NAT 后面、无公网 IP，
> compose 的 nginx 绑在 `127.0.0.1:18080`，校园网只放行了极少数站点
> （GitHub / ngrok / cloudflare / localhost.run 等免费穿透服务均不可达）。
> 所以走「**临时公网服务器 + SSH 反向隧道**」这条路。

---

## 0. 当前实际部署状态（已落地）

| 项 | 现状 |
|---|---|
| 公网服务器 | **8.160.116.34**（阿里云 ECS，Ubuntu 24.04，2 核 / 1.7 GB / 40 GB） |
| SSH | 端口 **55971**（22 未开放）；用户 `root`（管理）/ `nmg-tunnel`（隧道专用受限账号） |
| 边缘节点 | 容器 `nmg-edge-nginx`（compose 项目 `nmg-pku-alumni`，目录 `/opt/nmg-pku-alumni/edge`） |
| 对外端口 | **18080**（ufw 已放行；**阿里云安全组还需手动放行**，见第 5 节） |
| 公网暴露范围 | **只有 `/api/`**；根路径返回 404（管理后台只走 SSH 隧道） |
| 隧道方向 | 校园机**主动出站** → 阿里云（阿里云 → 校园机不可达，校园 NAT 只放行 SSH 转发端口） |
| 隧道账号 | `nmg-tunnel`，authorized_keys 限制为 `restrict,port-forwarding,permitlisten="127.0.0.1:18081"` |
| 小程序上传 | 计划在**阿里云**上跑（公网出口 IP 固定，正好加进微信的 IP 白名单） |

> ⚠️ **这台机器上还跑着别人的两个项目**（`openfeedback` 占 80/443、`schoolwall-cn` 的校园墙后端/PG/Redis）。
> 本项目的部署**完全不碰**它们：独立 compose 项目、`nmg-` 前缀、独立目录 `/opt/nmg-pku-alumni`、
> 不共享网络/卷/端口、不执行任何 prune 或全局 compose down。

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
入站  TCP 55971   来源 你的办公 IP（SSH；本机 22 未开放）
入站  TCP 18080   来源 0.0.0.0/0   （小程序 / 客户访问 API）
出站  全部        允许
```

> ⚠️ 本机 **80/443 已被既有的 Caddy（openfeedback 项目）占用**，
> 不要去动它 —— 我们的边缘节点走 **18080**。
> 服务器 OS 层的 ufw 我已加好 `18080/tcp ALLOW`（既有规则未动），
> 云厂商安全组需要你在控制台补一条。

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

## 二、部署步骤（已在 8.160.116.34 上实际执行过）

### 第 0 步：拿到服务器信息后要做的事

公网 IP、SSH 用户名、端口、登录方式（密码或密钥）。

### 第 1 步：建隧道专用受限账号（在公网服务器上执行）

```bash
bash infra/scripts/prep-tunnel-user.sh \
  --public-key "<校园机上 ~/.ssh/nmg_edge_key.pub 的内容>" \
  --permit-listen "127.0.0.1:18081"
```

它会建一个 `nmg-tunnel` 账号，authorized_keys 写成
`restrict,port-forwarding,permitlisten="127.0.0.1:18081"` ——
**能转发、不能开 shell、只能在指定端口监听**。
隧道私钥就算泄露，也拿不到 root、也开不了别的端口。

### 第 2 步：部署边缘节点（容器版，不动系统 nginx）

```bash
bash infra/scripts/deploy-edge-container.sh \
  --backend 127.0.0.1:18081 --listen 18080 --dir /opt/nmg-pku-alumni/edge
```

为什么用容器而不是装系统 nginx：这台机器的 80/443 已被 Caddy 占着，
装系统 nginx 会因端口冲突**直接起不来**；容器版则完全隔离
（独立 compose 项目 + `nmg-` 前缀 + `network_mode: host` 才能连到宿主机的隧道口）。

> ⚠️ nginx 配置是 bind mount，改完文件容器**不会**自动生效 ——
> 脚本里已经带上 `nginx -s reload`（踩过：配置改了但行为没变）。

### 第 3 步：校园机上建立反向隧道

```bash
ssh sqserver 'cd ~/MyProject/pkuim-alumni && bash infra/scripts/tunnel-public-edge.sh \
    --public-host 8.160.116.34 --public-port 55971 --remote-user nmg-tunnel \
    --local-port 18080 --remote-listen-port 18081 --daemon'
```

校园机**主动出站**（实测：阿里云 → 校园机不可达，校园 NAT 只放行 SSH 转发端口）。
守护进程断了自动重连；停它用 `--stop`（会连 ssh 子进程一起收干净，否则端口会一直被占）。

### 第 4 步：验收

```bash
# 公网机上
curl -sS http://127.0.0.1:18081/api/v1/system/health   # 隧道是否通
curl -sS http://127.0.0.1:18080/api/v1/system/health   # 边缘入口
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/   # 期望 404（后台不经公网）
```

### 第 5 步：放行安全组（**只能你在控制台做**）

阿里云安全组 → 入方向 → 手工添加：

| 协议 | 端口 | 授权对象 | 说明 |
|---|---|---|---|
| TCP | **18080** | `0.0.0.0/0` | 小程序与客户访问（**必须**，否则外网连接会超时） |

> 服务器 OS 层的 ufw 规则**已经加好了**（`18080/tcp ALLOW`），
> 但云厂商安全组在实例外面，只能你在控制台加。

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

1. **公网只暴露 `/api/`**：管理后台**不经公网**（根路径返回 404），
   继续走你的 SSH 隧道访问。原因是它的默认密码 `Admin@2026` 是
   硬编码在种子脚本里、还写在 README 上 —— 暴露到公网等于把后台送人。
   确实需要把后台也放出来时，给 `deploy-edge-container.sh` 加 `--allow-admin`，
   **并先改掉默认密码**。
2. **隧道账号是受限的**：`nmg-tunnel` 的 authorized_keys 写着
   `restrict,port-forwarding,permitlisten="127.0.0.1:18081"` ——
   不能开 shell、不能转发到别的端口。要撤销隧道：删掉这台机器上的
   `/home/nmg-tunnel/.ssh/authorized_keys` 即可。
3. **本机既有的两个项目我一行都没动**：`openfeedback`（80/443 的 Caddy）、
   `schoolwall-cn`（校园墙后端 + PG + Redis）。
   我们的东西全在 `/opt/nmg-pku-alumni/`，compose 项目名 `nmg-pku-alumni`，
   容器名 `nmg-edge-nginx`。
4. **校园机的 SSH 已被转发到公网**（`172.16.38.110:56127`）。请确认：
   只用密钥登录、`authorized_keys` 里没有来源不明的公钥。
5. **不要**把 MySQL / Redis 端口暴露到公网。公网机只跑一个 nginx 容器，隧道只转 HTTP。
6. **临时服务器到期前**：停边缘节点
   （`docker compose --project-name nmg-pku-alumni down`）、
   停校园机隧道（`bash infra/scripts/tunnel-public-edge.sh --stop`）、
   删掉 `nmg-tunnel` 账号、撤掉 ufw 的 18080 规则。

## 五、脚本索引

| 脚本 | 跑在哪 | 作用 |
|---|---|---|
| `infra/scripts/prep-tunnel-user.sh` | 公网服务器 | 建**受限**隧道账号（只转发、只听指定端口） |
| `infra/scripts/deploy-edge-container.sh` | 公网服务器 | **容器版**边缘节点（本机 80/443 被占时用这个） |
| `infra/scripts/deploy-public-edge.sh` | 公网服务器 | 边缘节点（**系统 nginx 版**，适合没有端口冲突的机器） |
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
