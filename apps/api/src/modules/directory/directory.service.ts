import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { paginate } from '../../common/dto/pagination.dto';
import type { PageResult } from '../../common/dto/pagination.dto';
import { decryptValue } from '../../common/utils/crypto';
import { normalizePair } from '../../common/utils/pair';
import { AlumniProfile, PrivateContact } from '../../database/entities/alumni.entity';
import { ConnectionPair, ConnectionRequestHistory } from '../../database/entities/connection.entity';
import { User } from '../../database/entities/user.entity';
import type { DirectoryQueryDto } from './dto/directory.dto';

export interface DirectoryEntry {
  userId: number;
  displayName: string;
  college: string | null;
  graduationYear: number | null;
  regionCode: string | null;
  regionName: string | null;
  industryCode: string | null;
  industryName: string | null;
  direction: string | null;
  verified: boolean;
  connectionState: 'none' | 'pending_outgoing' | 'pending_incoming' | 'connected';
}

@Injectable()
export class DirectoryService {
  constructor(
    @InjectRepository(AlumniProfile) private readonly profiles: Repository<AlumniProfile>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(ConnectionPair) private readonly pairs: Repository<ConnectionPair>,
    @InjectRepository(ConnectionRequestHistory)
    private readonly requests: Repository<ConnectionRequestHistory>,
    @InjectRepository(PrivateContact) private readonly contacts: Repository<PrivateContact>,
    private readonly config: ConfigService,
  ) {}

  /**
   * 管理端校友详情：包含联系方式解密视图。
   *
   * ⚠️ 隐私硬规则：本方法**仅供管理端**（alumni:view 权限）调用，
   * 严禁在通讯录 / 公开名片等普通用户路径上复用。
   */
  async adminDetail(targetUserId: number): Promise<Record<string, unknown>> {
    const profile = await this.profiles.findOne({
      where: { userId: targetUserId },
      relations: { region: true, industry: true },
    });
    if (!profile) throw new NotFoundException('校友不存在');
    const user = await this.users.findOne({ where: { id: targetUserId } });
    const contact = await this.contacts.findOne({ where: { userId: targetUserId } });
    const secret = this.config.get<string>('app.jwtSecret', 'change-me');

    return {
      userId: profile.userId,
      openid: user?.openid ?? null,
      nickname: user?.nickname ?? null,
      displayName: profile.displayName,
      realName: profile.realName,
      college: profile.college,
      degree: profile.degree,
      graduationYear: profile.graduationYear,
      regionCode: profile.regionCode,
      regionName: profile.region?.name ?? null,
      industryCode: profile.industryCode,
      industryName: profile.industry?.name ?? null,
      direction: profile.direction,
      intro: profile.intro,
      verified: profile.verified,
      verifiedAt: profile.verifiedAt,
      contactVisible: Boolean(profile.allowContactShare),
      showInDirectory: profile.showInDirectory,
      acceptContactRequests: profile.acceptContactRequests,
      allowContactShare: profile.allowContactShare,
      stage: user?.stage ?? 'logged_in',
      userStatus: user?.status ?? 'active',
      // 管理端视图：联系方式解密后返回（仅 admin:view 可见）
      contact: {
        phone: decryptValue(contact?.phoneCipher, secret),
        wechat: decryptValue(contact?.wechatCipher, secret),
        email: decryptValue(contact?.emailCipher, secret),
      },
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  /**
   * 通讯录列表。
   * 强制过滤：users.stage='verified' 且 alumni_profiles.show_in_directory=1；
   * 再按对方的字段级可见开关裁剪。联系方式永远不在此路径上出现。
   */
  async list(viewerId: number, query: DirectoryQueryDto): Promise<PageResult<DirectoryEntry>> {
    const qb = this.profiles
      .createQueryBuilder('p')
      .innerJoin(User, 'u', 'u.id = p.userId')
      .leftJoinAndSelect('p.region', 'region')
      .leftJoinAndSelect('p.industry', 'industry')
      .where('u.stage = :stage', { stage: 'verified' })
      .andWhere('u.status = :status', { status: 'active' })
      .andWhere('p.showInDirectory = :visible', { visible: true })
      // 通讯录展示的是「他人」，不包含自己
      .andWhere('p.userId != :viewerId', { viewerId });

    if (query.keyword?.trim()) {
      const keyword = `%${query.keyword.trim()}%`;
      qb.andWhere(
        new Brackets((where) => {
          where
            .orWhere('p.displayName LIKE :keyword', { keyword })
            // ⚠️ 下面这几个字段**受对方的可见开关控制**。
            //    「搜得到」本身就是泄露 —— 即使响应里把它们裁剪成 null，
            //    关键字命中与否也已经把值暴露了（缺陷 #105）。
            //    所以：**只有对方选择公开时**，该字段才允许被检索。
            .orWhere('(p.showCollege = :yes AND p.college LIKE :keyword)', { keyword, yes: true })
            .orWhere('(p.showDirection = :yes AND p.direction LIKE :keyword)', { keyword, yes: true })
            .orWhere('(p.showRegion = :yes AND region.name LIKE :keyword)', { keyword, yes: true })
            .orWhere('(p.showIndustry = :yes AND industry.name LIKE :keyword)', { keyword, yes: true });
          // ⚠️ `p.intro` **不在**契约的 DirectoryEntry 里，对他人从来不可见 ——
          //    拿它当检索键等于提供一个「简介内容存在性」的预言机，故不参与匹配。
        }),
      );
    }
    if (query.regionCode) {
      // 同理：地区受 showRegion 控制 → 对方未公开时不得被筛出（否则是等值预言机）
      qb.andWhere('p.showRegion = :yes', { yes: true }).andWhere('p.regionCode = :regionCode', {
        regionCode: query.regionCode,
      });
    }
    if (query.industryCode) {
      qb.andWhere('p.showIndustry = :yes', { yes: true }).andWhere('p.industryCode = :industryCode', {
        industryCode: query.industryCode,
      });
    }
    if (query.graduationYear) {
      qb.andWhere('p.graduationYear = :graduationYear', { graduationYear: query.graduationYear });
    }

    qb.orderBy('p.verified', 'DESC').addOrderBy('p.id', 'ASC');
    qb.skip(query.offset).take(query.take);

    const [entities, total] = await qb.getManyAndCount();
    const states = await this.connectionStates(viewerId, entities.map((item) => item.userId));

    const items = entities.map((profile) => ({
      userId: profile.userId,
      displayName: profile.displayName,
      college: profile.showCollege ? profile.college : null,
      graduationYear: profile.graduationYear,
      regionCode: profile.showRegion ? profile.regionCode : null,
      regionName: profile.showRegion ? (profile.region?.name ?? null) : null,
      industryCode: profile.showIndustry ? profile.industryCode : null,
      industryName: profile.showIndustry ? (profile.industry?.name ?? null) : null,
      direction: profile.showDirection ? profile.direction : null,
      verified: profile.verified,
      connectionState: states.get(profile.userId) ?? 'none',
    }));

    return paginate(items, total, query.page, query.pageSize);
  }

  async detail(viewerId: number, targetUserId: number): Promise<DirectoryEntry> {
    const profile = await this.profiles.findOne({
      where: { userId: targetUserId },
      relations: { region: true, industry: true },
    });
    if (!profile) throw new NotFoundException('校友不存在');
    const user = await this.users.findOne({ where: { id: targetUserId } });
    if (!user || user.status !== 'active' || user.stage !== 'verified' || !profile.showInDirectory) {
      // 未授权公开的资料不暴露存在性
      throw new NotFoundException('校友不存在');
    }
    const states = await this.connectionStates(viewerId, [targetUserId]);
    return {
      userId: profile.userId,
      displayName: profile.displayName,
      college: profile.showCollege ? profile.college : null,
      graduationYear: profile.graduationYear,
      regionCode: profile.showRegion ? profile.regionCode : null,
      regionName: profile.showRegion ? (profile.region?.name ?? null) : null,
      industryCode: profile.showIndustry ? profile.industryCode : null,
      industryName: profile.showIndustry ? (profile.industry?.name ?? null) : null,
      direction: profile.showDirection ? profile.direction : null,
      verified: profile.verified,
      connectionState: states.get(targetUserId) ?? 'none',
    };
  }

  /** 计算一批用户与当前用户的关系状态。 */
  private async connectionStates(
    viewerId: number,
    peerIds: number[],
  ): Promise<Map<number, DirectoryEntry['connectionState']>> {
    const states = new Map<number, DirectoryEntry['connectionState']>();
    if (peerIds.length === 0) return states;
    const [low, high] = normalizePair(viewerId, viewerId);
    void low;
    void high;

    const pairs = await this.pairs
      .createQueryBuilder('pair')
      .where('pair.status = :status', { status: 'active' })
      .andWhere(
        new Brackets((where) => {
          where
            .orWhere(
              new Brackets((inner) =>
                inner
                  .where('pair.userAId = :viewer', { viewer: viewerId })
                  .andWhere('pair.userBId IN (:...ids)', { ids: peerIds }),
              ),
            )
            .orWhere(
              new Brackets((inner) =>
                inner
                  .where('pair.userBId = :viewer', { viewer: viewerId })
                  .andWhere('pair.userAId IN (:...ids)', { ids: peerIds }),
              ),
            );
        }),
      )
      .getMany();

    for (const pair of pairs) {
      const peerId = pair.userAId === viewerId ? pair.userBId : pair.userAId;
      states.set(peerId, 'connected');
    }

    const pending = await this.requests
      .createQueryBuilder('req')
      .where('req.status = :pending', { pending: 'pending' })
      .andWhere(
        new Brackets((where) => {
          where
            .orWhere(
              new Brackets((inner) =>
                inner
                  .where('req.fromUserId = :viewer', { viewer: viewerId })
                  .andWhere('req.toUserId IN (:...ids)', { ids: peerIds }),
              ),
            )
            .orWhere(
              new Brackets((inner) =>
                inner
                  .where('req.toUserId = :viewer', { viewer: viewerId })
                  .andWhere('req.fromUserId IN (:...ids)', { ids: peerIds }),
              ),
            );
        }),
      )
      .getMany();

    for (const request of pending) {
      const outgoing = request.fromUserId === viewerId;
      const peerId = outgoing ? request.toUserId : request.fromUserId;
      if (states.get(peerId) === 'connected') continue;
      states.set(peerId, outgoing ? 'pending_outgoing' : 'pending_incoming');
    }

    return states;
  }

  /**
   * 管理端：全部校友（含未认证/未公开），带筛选。
   *
   * 响应字段必须与契约 `AlumniProfileDto` + 后台本地 `AdminAlumniListItem` 一致：
   *   - `userStatus`（账号状态）——后台页面按这个字段渲染「账号状态」列，
   *     之前服务端返回的是 `status`，导致该列恒为空；
   *   - `intro` / `verifiedAt` / `contactVisible` / `updatedAt` ——契约声明为必填。
   * 详见 docs/KNOWN-ISSUES.md #59。
   */
  async adminList(query: {
    keyword?: string;
    stage?: string;
    regionCode?: string;
    college?: string;
    verified?: boolean;
    status?: string;
    industryCode?: string;
    graduationYear?: number;
    page: number;
    pageSize: number;
  }): Promise<PageResult<Record<string, unknown>>> {
    const qb = this.profiles
      .createQueryBuilder('p')
      .innerJoin(User, 'u', 'u.id = p.userId')
      .leftJoinAndSelect('p.region', 'region')
      .leftJoinAndSelect('p.industry', 'industry')
      .orderBy('p.id', 'DESC');

    if (query.keyword?.trim()) {
      const keyword = `%${query.keyword.trim()}%`;
      qb.andWhere(
        new Brackets((where) => {
          where
            .orWhere('p.displayName LIKE :keyword', { keyword })
            .orWhere('p.realName LIKE :keyword', { keyword })
            .orWhere('p.college LIKE :keyword', { keyword })
            .orWhere('u.openid LIKE :keyword', { keyword });
        }),
      );
    }
    if (query.stage) {
      qb.andWhere('u.stage = :stage', { stage: query.stage });
    }
    if (query.regionCode) {
      qb.andWhere('p.regionCode = :regionCode', { regionCode: query.regionCode });
    }
    // 后台「校友管理」页面提供的其余筛选项，服务端必须真正生效，
    // 否则筛选框只是摆设（前端照常发请求，结果不受影响）。详见 KNOWN-ISSUES #59。
    if (query.college?.trim()) {
      qb.andWhere('p.college LIKE :college', { college: `%${query.college.trim()}%` });
    }
    if (query.verified !== undefined) {
      qb.andWhere('p.verified = :verified', { verified: query.verified });
    }
    if (query.status) {
      qb.andWhere('u.status = :status', { status: query.status });
    }
    if (query.industryCode) {
      qb.andWhere('p.industryCode = :industryCode', { industryCode: query.industryCode });
    }
    if (query.graduationYear !== undefined) {
      qb.andWhere('p.graduationYear = :graduationYear', { graduationYear: query.graduationYear });
    }

    qb.skip((query.page - 1) * query.pageSize).take(query.pageSize);
    const [entities, total] = await qb.getManyAndCount();
    const userIds = entities.map((item) => item.userId);
    const users = userIds.length
      ? await this.users.find({ where: { id: In(userIds) } })
      : [];
    const userMap = new Map(users.map((item) => [item.id, item]));

    const items = entities.map((profile) => {
      const user = userMap.get(profile.userId);
      return {
        userId: profile.userId,
        openid: user?.openid ?? null,
        nickname: user?.nickname ?? null,
        displayName: profile.displayName,
        realName: profile.realName,
        college: profile.college,
        degree: profile.degree,
        graduationYear: profile.graduationYear,
        regionCode: profile.regionCode,
        regionName: profile.region?.name ?? null,
        industryCode: profile.industryCode,
        industryName: profile.industry?.name ?? null,
        direction: profile.direction,
        intro: profile.intro,
        verified: profile.verified,
        verifiedAt: profile.verifiedAt,
        contactVisible: Boolean(profile.allowContactShare),
        showInDirectory: profile.showInDirectory,
        stage: user?.stage ?? 'logged_in',
        userStatus: user?.status ?? 'active',
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      };
    });

    return paginate(items, total, query.page, query.pageSize);
  }
}
