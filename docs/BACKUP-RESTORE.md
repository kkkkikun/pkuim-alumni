# 备份与恢复（BACKUP-RESTORE）

> 依据 `docs/top.md` §11.1：MySQL 定期备份、MinIO 对象文件备份、配置文件独立备份、
> 备份校验、定期恢复演练。**「命令执行成功」不等于「能恢复」——恢复演练是必做项。**
>
> 对应脚本：`infra/scripts/backup.sh`、`infra/scripts/restore.sh`

---

## 0. 备份策略

| 对象 | 方式 | 频率（建议） | 产物 |
| --- | --- | --- | --- |
| MySQL | `mysqldump --single-transaction`（一致性快照，不锁表） | 每日 + 发布前 | `mysql-<db>.sql.gz` |
| MinIO | `mc mirror`（公开桶 + 私有桶） | 与 MySQL 同周期 | `minio/<bucket>/` |
| 配置文件 | 复制 compose / infra / `.env.prod`（600） | 每次发布 | `config/` |
| 校验 | `sha256sum` 清单 | 每次备份 | `manifest.sha256` |

默认保留 7 天（`BACKUP_RETENTION_DAYS`），保留策略只删除「时间戳命名的目录」，
且必须位于 `BACKUP_DIR` 之内，避免误删其它路径。

备份目录（服务器）：`/home/kikun/backups/nmg-pku-alumni`

---

## 1. 手工备份

```bash
ssh sqserver
cd /home/kikun/MyProject/pkuim-alumni

bash infra/scripts/backup.sh
```

输出示例：

```
[2026-11-15 10:15:00] 备份目录：/home/kikun/backups/nmg-pku-alumni/20261115-101500
[2026-11-15 10:15:04] 导出 MySQL 数据库 nmg_alumni
[2026-11-15 10:15:12] MySQL 备份完成：48M
[2026-11-15 10:15:20] 镜像 MinIO 桶：nmg-public
[2026-11-15 10:15:22] 镜像 MinIO 桶：nmg-private
[2026-11-15 10:15:25] 备份配置文件
[2026-11-15 10:15:26] 生成校验清单
[2026-11-15 10:15:27] 备份完成并通过校验：/home/kikun/backups/nmg-pku-alumni/20261115-101500
```

自定义参数：

```bash
# 指定目录与保留天数
BACKUP_DIR=/data/nmg-backups BACKUP_RETENTION_DAYS=14 bash infra/scripts/backup.sh

# 只导数据库，不导对象存储
WITH_MINIO=0 bash infra/scripts/backup.sh
```

产物结构：

```
/home/kikun/backups/nmg-pku-alumni/20261115-101500/
├── mysql-nmg_alumni.sql.gz
├── manifest.sha256
├── manifest.meta
├── config/
│   ├── docker-compose.prod.yml
│   ├── env.prod            (600，含密钥，注意保密)
│   └── infra/
└── minio/
    ├── nmg-public/
    └── nmg-private/
```

---

## 2. 校验备份完整性

```bash
cd /home/kikun/backups/nmg-pku-alumni/20261115-101500
sha256sum -c manifest.sha256        # 全部 OK 才算通过
gzip -t mysql-nmg_alumni.sql.gz     # 转储文件可解压
```

---

## 3. 恢复演练（**必须定期做**）

`restore.sh` 永远恢复到**全新数据库名**，默认不触碰线上库。

```bash
cd /home/kikun/MyProject/pkuim-alumni

bash infra/scripts/restore.sh \
  --backup /home/kikun/backups/nmg-pku-alumni/20261115-101500 \
  --target-db nmg_restore_drill
```

脚本会依次完成：

1. `gzip -t` 与 `manifest.sha256` 双重校验；
2. `DROP DATABASE IF EXISTS` 同名旧库 → `CREATE DATABASE`（`utf8mb4 / utf8mb4_0900_ai_ci`）；
3. 导入转储；
4. 校验：表数量（与转储中 `CREATE TABLE` 数一致）、关键表行数
   （`users` / `alumni_profiles` / `events` / `event_registrations` /
   `connection_pairs` / `resource_posts`）、默认字符集；
5. 输出对比结果。

演练完成后清理临时库：

```bash
bash infra/scripts/restore.sh \
  --backup /home/kikun/backups/nmg-pku-alumni/20261115-101500 \
  --target-db nmg_restore_drill --drop
```

同时恢复对象存储（可选）：

```bash
bash infra/scripts/restore.sh \
  --backup /home/kikun/backups/nmg-pku-alumni/20261115-101500 \
  --with-minio
```

> 注意：`restore.sh` 会拒绝把线上库名作为目标库（`MYSQL_DATABASE`），误操作会被直接拒绝。

---

## 4. 真正的灾备恢复（线上库需要回退时）

前置：**先做一次当前状态备份**，再操作，避免二次损坏。

```bash
cd /home/kikun/MyProject/pkuim-alumni

# 1) 立即备份当前状态
bash infra/scripts/backup.sh

# 2) 停止写入（保留容器，暂停 API/Worker）
docker compose --project-name nmg-pku-alumni --env-file .env.prod \
  -f docker-compose.prod.yml stop api worker

# 3) 恢复到「临时库」并核对
bash infra/scripts/restore.sh \
  --backup /home/kikun/backups/nmg-pku-alumni/20261115-101500 \
  --target-db nmg_recovered

# 4) 人工核对后切换（示例：把恢复库改名为线上库）
docker compose --project-name nmg-pku-alumni --env-file .env.prod \
  -f docker-compose.prod.yml exec -T mysql mysql -uroot -p'<root 密码>' -e "
    RENAME DATABASE nmg_alumni TO nmg_alumni_failed_20261115,
                 nmg_recovered TO nmg_alumni;"

# 5) 恢复服务并做健康检查
docker compose --project-name nmg-pku-alumni --env-file .env.prod \
  -f docker-compose.prod.yml start api worker
bash infra/scripts/healthcheck.sh --wait --timeout 300
```

> 第 4 步会改线上库名，**执行前必须确认备份可用**，并保留 `nmg_alumni_failed_*` 以便回退。

---

## 5. 定时备份（crontab）

服务器上以 `kikun` 用户添加：

```bash
crontab -e
```

```cron
# 每日 02:30 全量备份
30 2 * * * cd /home/kikun/MyProject/pkuim-alumni && /bin/bash infra/scripts/backup.sh >> /home/kikun/backups/nmg-pku-alumni/backup.log 2>&1
# 每 6 小时增量式全量备份（数据量小，全量即可）
0 */6 * * * cd /home/kikun/MyProject/pkuim-alumni && /bin/bash infra/scripts/backup.sh >> /home/kikun/backups/nmg-pku-alumni/backup.log 2>&1
```

建议再加一个「每周恢复演练」的定时任务，把演练结果写入日志：

```bash
0 3 * * 0 cd /home/kikun/MyProject/pkuim-alumni && /bin/bash infra/scripts/restore.sh --backup "$(ls -1dt /home/kikun/backups/nmg-pku-alumni/*/ | head -1)" --target-db nmg_restore_drill --drop >> /home/kikun/backups/nmg-pku-alumni/restore-drill.log 2>&1
```

---

## 6. 备份文件异地留存（可选）

备份目录在服务器本地磁盘上，磁盘损坏即全部丢失。至少复制一份到其它介质：

```bash
# 从服务器拉一份到本地（本地保留最近 7 份）
mkdir -p /home/kikun/backups/nmg-pku-alumni
scp -r sqserver:/home/kikun/backups/nmg-pku-alumni/20261115-101500 \
      /home/kikun/backups/nmg-pku-alumni/
```

> `config/env.prod` 含数据库密码与 JWT 密钥，异地副本请设置 `chmod 600` 并放在加密介质中。

---

## 7. 安全约束（务必遵守）

- 备份脚本**不会**执行任何 `docker prune`、`docker volume rm`；
- 保留策略只删除 `BACKUP_DIR` 内、名称匹配 `YYYYMMDD-HHMMSS` 的目录；
- 备份中的 `.env.prod` 权限为 `600`；
- 恢复脚本只允许写入**新建的**数据库，拒绝覆盖线上库；
- 任何备份/恢复都不触碰 `swload-*` 项目的容器与卷。

---

## 8. 相关文档

- `docs/DEPLOYMENT.md` —— 部署与回滚
- `docs/SERVER-OPERATIONS.md` —— 日常运维与排障
- `docs/top.md` §11 —— 数据备份、恢复和安全总纲
