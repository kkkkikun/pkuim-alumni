import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { paginate } from '../../common/dto/pagination.dto';
import type { PageResult } from '../../common/dto/pagination.dto';
import { decryptValue } from '../../common/utils/crypto';
import { normalizePair, pairKey } from '../../common/utils/pair';
import { AlumniProfile, PrivateContact } from '../../database/entities/alumni.entity';
import {
  ConnectionPair,
  ConnectionRequestHistory,
  ContactShareGrant,
} from '../../database/entities/connection.entity';
import { User } from '../../database/entities/user.entity';
import { NotificationService } from '../notifications/notification.service';
import type { CreateConnectionRequestDto } from './dto/connection.dto';

export interface ConnectionRequestView {
  id: number;
  fromUserId: number;
  toUserId: number;
  fromName: string;
  toName: string;
  message: string;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  pairId: number | null;
}

export interface ConnectionView {
  id: number;
  userAId: number;
  userBId: number;
  peerUserId: number;
  peerName: string;
  peerCollege: string | null;
  peerRegionName: string | null;
  peerIndustryName: string | null;
  status: string;
  establishedAt: Date;
  myContactShared: boolean;
  peerContactShared: boolean;
  peerContact: {
    name: string;
    phone: string | null;
    wechat: string | null;
    email: string | null;
  } | null;
}

@Injectable()
export class ConnectionsService {
  constructor(
    @InjectRepository(ConnectionRequestHistory)
    private readonly requests: Repository<ConnectionRequestHistory>,
    @InjectRepository(ConnectionPair) private readonly pairs: Repository<ConnectionPair>,
    @InjectRepository(ContactShareGrant) private readonly grants: Repository<ContactShareGrant>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(AlumniProfile) private readonly profiles: Repository<AlumniProfile>,
    @InjectRepository(PrivateContact) private readonly contacts: Repository<PrivateContact>,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationService,
    private readonly config: ConfigService,
  ) {}

  private get secret(): string {
    return this.config.get<string>('app.jwtSecret', 'change-me');
  }

  /**
   * 提交联系申请。
   * 并发要点：同一对用户的 pending 申请由唯一索引 uk_connection_request_pending 保证只有一条，
   * 重复提交（含 A、B 同时互申）返回既有申请而不是报错。
   */
  async createRequest(fromUserId: number, dto: CreateConnectionRequestDto) {
    // 统一数值化后再比较，避免 id 类型（number/string）差异导致自申请漏判
    const targetUserId = Number(dto.targetUserId);
    const actorUserId = Number(fromUserId);
    if (!Number.isInteger(targetUserId) || targetUserId < 1) {
      throw new BadRequestException('目标校友参数不合法');
    }
    if (targetUserId === actorUserId) {
      throw new BadRequestException('不能向自己发起联系申请');
    }
    const target = await this.users.findOne({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException('校友不存在');
    if (target.stage !== 'verified') {
      throw new ForbiddenException('对方尚未完成校友认证');
    }
    const targetProfile = await this.profiles.findOne({ where: { userId: target.id } });
    if (!targetProfile || !targetProfile.acceptContactRequests) {
      throw new ForbiddenException('对方暂不接受联系申请');
    }

    const key = pairKey(actorUserId, Number(target.id));
    const existingPair = await this.findActivePair(fromUserId, target.id);
    if (existingPair) {
      throw new ConflictException('你们已经是校友连接关系');
    }

    const existingRequest = await this.requests.findOne({
      where: { pairKey: key, status: 'pending' },
    });
    if (existingRequest) {
      // 幂等：已有待处理申请，直接返回既有记录（HTTP 200 + idempotent=true）
      return { ...(await this.toRequestView(existingRequest)), idempotent: true };
    }

    try {
      // 申请写入与通知写入必须同事务（缺陷 #99）：
      // 否则通知写失败时，申请已经提交 —— 用户看到 500，却留下了一条
      // 永远收不到通知的申请。
      const createdId = await this.dataSource.transaction(async (manager) => {
        const requests = manager.getRepository(ConnectionRequestHistory);
        const created = await requests.save(
          requests.create({
            fromUserId,
            toUserId: target.id,
            pairKey: key,
            pendingGuard: key,
            message: dto.message,
            status: 'pending',
          }),
        );
        await this.notifications.push(
          target.id,
          'connection_request',
          '收到一条联系申请',
          `${dto.message.slice(0, 60)}`,
          { requestId: created.id, fromUserId },
          { eventType: 'connection.request.created', aggregateType: 'connection_request', aggregateId: String(created.id) },
          manager,
        );
        return created.id;
      });
      const created = await this.requests.findOne({ where: { id: createdId } });
      if (!created) throw new NotFoundException('联系申请不存在');
      return { ...(await this.toRequestView(created)), idempotent: false };
    } catch (error) {
      if (error instanceof QueryFailedError && this.isDuplicateKey(error)) {
        // 并发下另一方已插入 pending 申请，返回既有记录
        const concurrent = await this.requests.findOne({ where: { pairKey: key, status: 'pending' } });
        if (concurrent) {
          // 并发下另一方已插入 pending 申请：返回既有记录（不重复创建）
          return { ...(await this.toRequestView(concurrent)), idempotent: true };
        }
      }
      throw error;
    }
  }

  /** 接受申请：条件更新保证重复点击幂等，并原子建立连接关系。 */
  async accept(requestId: number, actorUserId: number) {
    const request = await this.requests.findOne({ where: { id: requestId } });
    if (!request) throw new NotFoundException('联系申请不存在');
    if (Number(request.toUserId) !== Number(actorUserId)) {
      throw new ForbiddenException('只有接收方可以接受该申请');
    }
    if (request.status !== 'pending') {
      // 幂等：已处理过直接返回当前状态
      return this.toRequestView(request);
    }

    const [userAId, userBId] = normalizePair(request.fromUserId, request.toUserId);

    const pairId = await this.dataSource.transaction(async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(ConnectionRequestHistory)
        .set({ status: 'accepted', decidedAt: new Date(), decidedBy: null })
        .where('id = :id', { id: requestId })
        .andWhere('status = :pending', { pending: 'pending' })
        .execute();
      if (!result.affected) {
        // 已被处理：读取最新状态
        const current = await manager.findOne(ConnectionRequestHistory, { where: { id: requestId } });
        return current?.pairId ?? null;
      }

      await manager
        .createQueryBuilder()
        .insert()
        .into(ConnectionPair)
        .values({
          userAId,
          userBId,
          status: 'active',
          establishedAt: new Date(),
        })
        .orIgnore()
        .execute();

      const pair = await manager.findOne(ConnectionPair, { where: { userAId, userBId } });
      if (pair) {
        await manager
          .createQueryBuilder()
          .update(ConnectionRequestHistory)
          .set({ pairId: pair.id })
          .where('id = :id', { id: requestId })
          .execute();
      }

      // 通知与「接受申请 + 建立连接关系」同事务（缺陷 #99）
      await this.notifications.push(
        request.fromUserId,
        'connection_decision',
        '你的联系申请已被接受',
        '你们已建立校友连接关系，可以在「我的连接」中管理联系方式授权。',
        { requestId, pairId: pair?.id ?? null },
        { eventType: 'connection.request.accepted', aggregateType: 'connection_request', aggregateId: String(requestId) },
        manager,
      );
      return pair?.id ?? null;
    });

    const updated = await this.requests.findOne({ where: { id: requestId } });
    return this.toRequestView(updated ?? request);
  }

  async reject(requestId: number, actorUserId: number) {
    const request = await this.requests.findOne({ where: { id: requestId } });
    if (!request) throw new NotFoundException('联系申请不存在');
    if (request.toUserId !== actorUserId) {
      throw new ForbiddenException('只有接收方可以处理该申请');
    }
    if (request.status !== 'pending') {
      return this.toRequestView(request);
    }
    // 驳回与通知同事务（缺陷 #99）
    const updated = await this.dataSource.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .update(ConnectionRequestHistory)
        .set({ status: 'rejected', decidedAt: new Date(), pendingGuard: null })
        .where('id = :id', { id: requestId })
        .andWhere('status = :pending', { pending: 'pending' })
        .execute();

      await this.notifications.push(
        request.fromUserId,
        'connection_decision',
        '你的联系申请未通过',
        '对方暂时没有接受本次联系申请，你可以稍后再试。',
        { requestId },
        { eventType: 'connection.request.rejected', aggregateType: 'connection_request', aggregateId: String(requestId) },
        manager,
      );
      return manager.findOne(ConnectionRequestHistory, { where: { id: requestId } });
    });
    return this.toRequestView(updated ?? request);
  }

  async cancel(requestId: number, actorUserId: number) {
    const request = await this.requests.findOne({ where: { id: requestId } });
    if (!request) throw new NotFoundException('联系申请不存在');
    if (request.fromUserId !== actorUserId) {
      throw new ForbiddenException('只有发起方可以撤回该申请');
    }
    if (request.status !== 'pending') {
      return this.toRequestView(request);
    }
    await this.requests
      .createQueryBuilder()
      .update(ConnectionRequestHistory)
      .set({ status: 'cancelled', decidedAt: new Date(), pendingGuard: null })
      .where('id = :id', { id: requestId })
      .andWhere('status = :pending', { pending: 'pending' })
      .execute();
    const updated = await this.requests.findOne({ where: { id: requestId } });
    return this.toRequestView(updated ?? request);
  }

  /** 申请详情：仅发起方或接收方可见。 */
  async requestDetail(id: number, viewerId: number) {
    const request = await this.requests.findOne({ where: { id } });
    if (!request) throw new NotFoundException('联系申请不存在');
    if (request.fromUserId !== viewerId && request.toUserId !== viewerId) {
      throw new ForbiddenException('无权查看该联系申请');
    }
    return this.toRequestView(request);
  }

  async listRequests(
    userId: number,
    direction: 'incoming' | 'outgoing',
    status?: string,
    page = 1,
    pageSize = 20,
  ) {
    const where: Record<string, unknown> =
      direction === 'outgoing' ? { fromUserId: userId } : { toUserId: userId };
    if (status) where.status = status;
    const [rows, total] = await this.requests.findAndCount({
      where,
      order: { id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    // toRequestView 是异步的，必须整体 await —— 否则返回的是 Promise 数组，
    // 序列化后每项都会变成 {}。
    const items = await Promise.all(rows.map((row) => this.toRequestView(row)));
    return paginate(items, total, page, pageSize);
  }

  /** 已建立的连接列表（含双方联系方式授权状态）。 */
  async listConnections(userId: number, page = 1, pageSize = 20): Promise<PageResult<ConnectionView>> {
    const qb = this.pairs
      .createQueryBuilder('pair')
      .where('pair.status = :status', { status: 'active' })
      .andWhere('(pair.userAId = :userId OR pair.userBId = :userId)', { userId })
      .orderBy('pair.id', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    const [pairs, total] = await qb.getManyAndCount();
    const items = await Promise.all(pairs.map((pair) => this.toConnectionView(pair, userId)));
    return paginate(items, total, page, pageSize);
  }

  /** 单个连接关系详情（仅关系双方可见）。 */
  async getConnection(pairId: number, userId: number) {
    const pair = await this.pairs.findOne({ where: { id: pairId } });
    if (!pair) throw new NotFoundException('连接关系不存在');
    if (pair.userAId !== userId && pair.userBId !== userId) {
      throw new ForbiddenException('无权查看该连接关系');
    }
    return this.toConnectionView(pair, userId);
  }

  async revokeConnection(pairId: number, userId: number) {
    const pair = await this.pairs.findOne({ where: { id: pairId } });
    if (!pair) throw new NotFoundException('连接关系不存在');
    if (pair.userAId !== userId && pair.userBId !== userId) {
      throw new ForbiddenException('无权解除该连接关系');
    }
    await this.dataSource.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .update(ConnectionPair)
        .set({ status: 'revoked', revokedAt: new Date(), version: pair.version + 1 })
        .where('id = :id', { id: pairId })
        .execute();
      // 关系解除时同时撤销双方的联系方式授权，避免残留授权
      await manager
        .createQueryBuilder()
        .update(ContactShareGrant)
        .set({ allow: false })
        .where('pair_id = :pairId', { pairId })
        .execute();
    });
    return { revoked: true, pairId };
  }

  /** 授权 / 撤回向对方展示我的联系方式。 */
  async setContactGrant(pairId: number, userId: number, allow: boolean) {
    const pair = await this.pairs.findOne({ where: { id: pairId } });
    if (!pair) throw new NotFoundException('连接关系不存在');
    if (pair.status !== 'active') {
      throw new ConflictException('连接关系已解除');
    }
    if (pair.userAId !== userId && pair.userBId !== userId) {
      throw new ForbiddenException('无权操作该连接关系');
    }
    const existing = await this.grants.findOne({ where: { pairId, userId } });
    if (existing) {
      existing.allow = allow;
      await this.grants.save(existing);
      return this.toConnectionView(pair, userId);
    }
    try {
      await this.grants.save(this.grants.create({ pairId, userId, allow }));
    } catch (error) {
      // ⚠️ 并发下两个请求都读不到既有行 → 都会去 INSERT，
      //    后到的那一个撞唯一索引 `uk_contact_grant (pair_id, user_id)`（缺陷 #137）。
      //    「先查后插」在单线程下没问题，**并发**下必须有兜底：
      //    捕获唯一键冲突后改成**更新**既有行，而不是甩 500 给用户。
      if (!this.isDuplicateKey(error)) throw error;
      const concurrent = await this.grants.findOne({ where: { pairId, userId } });
      if (!concurrent) throw error;
      concurrent.allow = allow;
      await this.grants.save(concurrent);
    }
    return this.toConnectionView(pair, userId);
  }

  /* ------------------------------ 内部方法 ------------------------------ */

  private async findActivePair(a: number, b: number): Promise<ConnectionPair | null> {
    const [userAId, userBId] = normalizePair(a, b);
    return this.pairs.findOne({ where: { userAId, userBId, status: 'active' } });
  }

  /** MySQL 唯一键冲突（ER_DUP_ENTRY / 1062）。 */
  private isDuplicateKey(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driverError = error.driverError as { code?: string; errno?: number } | undefined;
    return driverError?.code === 'ER_DUP_ENTRY' || driverError?.errno === 1062;
  }

  private async toRequestView(request: ConnectionRequestHistory): Promise<ConnectionRequestView> {
    const [from, to] = await Promise.all([
      this.users.findOne({ where: { id: request.fromUserId } }),
      this.users.findOne({ where: { id: request.toUserId } }),
    ]);
    return {
      id: request.id,
      fromUserId: request.fromUserId,
      toUserId: request.toUserId,
      fromName: from?.nickname ?? '校友',
      toName: to?.nickname ?? '校友',
      message: request.message,
      status: request.status,
      createdAt: request.createdAt,
      decidedAt: request.decidedAt,
      pairId: request.pairId,
    };
  }

  private async toConnectionView(pair: ConnectionPair, viewerId: number): Promise<ConnectionView> {
    const peerId = pair.userAId === viewerId ? pair.userBId : pair.userAId;
    const [peerProfile, myProfile, myGrant, peerGrant] = await Promise.all([
      this.profiles.findOne({ where: { userId: peerId }, relations: { region: true, industry: true } }),
      this.profiles.findOne({ where: { userId: viewerId } }),
      this.grants.findOne({ where: { pairId: pair.id, userId: viewerId } }),
      this.grants.findOne({ where: { pairId: pair.id, userId: peerId } }),
    ]);

    const myShared = Boolean(myGrant?.allow) && Boolean(myProfile?.allowContactShare);
    const peerShared = Boolean(peerGrant?.allow) && Boolean(peerProfile?.allowContactShare);

    let peerContact: ConnectionView['peerContact'] = null;
    if (myShared && peerShared) {
      const contact = await this.contacts.findOne({ where: { userId: peerId } });
      if (contact) {
        peerContact = {
          name: peerProfile?.displayName ?? '校友',
          phone: decryptValue(contact.phoneCipher, this.secret),
          wechat: decryptValue(contact.wechatCipher, this.secret),
          email: decryptValue(contact.emailCipher, this.secret),
        };
      }
    }

    return {
      id: pair.id,
      userAId: pair.userAId,
      userBId: pair.userBId,
      peerUserId: peerId,
      peerName: peerProfile?.displayName ?? '校友',
      peerCollege: peerProfile?.college ?? null,
      peerRegionName: peerProfile?.region?.name ?? null,
      peerIndustryName: peerProfile?.industry?.name ?? null,
      status: pair.status,
      establishedAt: pair.establishedAt,
      myContactShared: myShared,
      peerContactShared: peerShared,
      peerContact,
    };
  }
}
