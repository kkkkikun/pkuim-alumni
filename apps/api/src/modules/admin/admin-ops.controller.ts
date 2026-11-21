import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators';
import { InvalidationBusService } from '../../common/services/invalidation-bus.service';

/**
 * 管理端·**只读运维**端点（第七轮引入）。
 *
 * ## 为什么需要它
 *
 * 多实例部署时，「跨实例撤权 / 字典失效**到底生效没有**」此前只能靠翻日志：
 * 要在**每个实例**上分别确认「订阅上频道了没有」「收到过事件没有」，
 * 出问题时定位很慢，而且**翻日志看不出「这个实例压根没订阅上」**。
 *
 * ## 为什么**不改**对外的健康检查端点
 *
 * - `GET /healthz`（存活探针）与 `GET /api/v1/system/health`（依赖连通性）
 *   都是**公开**端点：把频道名、事件计数与 `lastError` 挂上去，
 *   等于把内部拓扑与错误信息**对外暴露**（`docs/SECURITY.md` 第 5 节「传输与暴露面」）；
 * - 它们的响应形状是**对外契约**（`packages/contracts` + `docs/API-SPEC.md`），
 *   改形状要连带评估两端客户端（契约镜像 / 响应结构校验器）；
 * - 语义也不对：健康检查回答的是「**这个实例还活着吗**」，
 *   而总线状态回答的是「**跨实例失效链路通不通**」——
 *   混在一起会让「degraded」的含义变得含糊。
 *
 * 所以这里**另开一个只读运维端点**：不改既有对外契约、不新增对外暴露面，
 * 只对**管理员**开放（口径见 `docs/SECURITY.md` 第 2.1.9 节）。
 *
 * ## 运维怎么读它
 *
 * | 字段 | 读法 |
 * |---|---|
 * | `enabled` | `false` = 总线被 `RBAC_INVALIDATION_ENABLED=false` 整条关闭（撤权延迟回落到 TTL 上界） |
 * | `channel` | **生效频道**（按环境隔离；所有实例必须一致，否则事件互相打不到） |
 * | `subscribed` | `false` = **本实例没订阅上** —— 多实例下这一档的撤权延迟会回落到 TTL 上界 |
 * | `published` / `received` | 本进程累计发布 / 收到的失效事件数（判断「有没有在发」「有没有在收」） |
 * | `lastError` | 最近一次总线错误（Redis 连不上等）；`null` = 没有 |
 * | `degraded` | `true` = 总线开着但**没订阅上**（= 处于 TTL 兜底那一档） |
 *
 * ⚠️ 本端点**只读**：不提供「强制重订阅」「清缓存」之类的写操作 ——
 *    总线恢复后自动重新订阅是实现自己的责任（`docs/SECURITY.md` 第 2.1.5 节）。
 */
@ApiTags('运维')
@Controller('admin/ops')
export class AdminOpsController {
  constructor(private readonly bus: InvalidationBusService) {}

  /**
   * 共享失效总线的运行状态。
   *
   * ⚠️ 只允许**管理员**（`admin:manage` 权限点）访问：
   *    频道名与错误信息属于内部信息，不对普通校友与匿名请求开放。
   */
  @RequirePermissions('admin:manage')
  @Get('invalidation-bus')
  @ApiOperation({ summary: '共享失效总线状态（只读，多实例部署自证用）' })
  invalidationBusStatus() {
    const stats = this.bus.stats;
    return {
      enabled: stats.enabled,
      channel: stats.channel,
      subscribed: stats.subscribed,
      published: stats.published,
      received: stats.received,
      lastError: stats.lastError ?? null,
      /**
       * 「开着但没订阅上」= 处于**TTL 兜底**那一档
       * （多实例部署时撤权延迟 ≤ TTL，而不是 0）。
       */
      degraded: stats.enabled && !stats.subscribed,
    };
  }
}
