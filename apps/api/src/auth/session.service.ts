import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { UserSession } from '../database/entities/user.entity';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: number;
}

/**
 * 会话管理：refresh token 只以哈希形式落库，登出/轮换即吊销。
 * MySQL 是唯一事实来源；Redis 仅在后续作为可选缓存加速。
 */
@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(UserSession)
    private readonly sessions: Repository<UserSession>,
  ) {}

  async create(
    userId: number,
    refreshToken: string,
    refreshTokenHash: string,
    expiresAt: Date,
    meta: { ip?: string | null; device?: string | null; userAgent?: string | null } = {},
  ): Promise<UserSession> {
    const session = this.sessions.create({
      userId,
      refreshTokenHash,
      device: meta.device ?? null,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      expiresAt,
      revokedAt: null,
    });
    return this.sessions.save(session);
  }

  async findActiveByHash(refreshTokenHash: string): Promise<UserSession | null> {
    const session = await this.sessions.findOne({
      where: { refreshTokenHash },
      order: { id: 'DESC' },
    });
    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;
    return session;
  }

  async revoke(session: UserSession): Promise<void> {
    if (session.revokedAt) return;
    await this.sessions.update({ id: session.id }, { revokedAt: new Date() });
  }

  async revokeByHash(refreshTokenHash: string): Promise<void> {
    await this.sessions
      .createQueryBuilder()
      .update(UserSession)
      .set({ revokedAt: new Date() })
      .where('refresh_token_hash = :hash', { hash: refreshTokenHash })
      .andWhere('revoked_at IS NULL')
      .execute();
  }

  async revokeAllForUser(userId: number): Promise<void> {
    await this.sessions
      .createQueryBuilder()
      .update(UserSession)
      .set({ revokedAt: new Date() })
      .where('user_id = :userId', { userId })
      .andWhere('revoked_at IS NULL')
      .execute();
  }

  static newSessionId(): string {
    return randomUUID();
  }
}
