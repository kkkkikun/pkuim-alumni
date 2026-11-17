import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { decryptValue, encryptValue } from '../../common/utils/crypto';
import { AlumniProfile, PrivateContact } from '../../database/entities/alumni.entity';
import { User } from '../../database/entities/user.entity';
import type { UpdateContactDto, UpdatePrivacyDto, UpdateProfileDto } from './dto/me.dto';

@Injectable()
export class MeService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(AlumniProfile) private readonly profiles: Repository<AlumniProfile>,
    @InjectRepository(PrivateContact) private readonly contacts: Repository<PrivateContact>,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  private get secret(): string {
    return this.config.get<string>('app.jwtSecret', 'change-me');
  }

  /** 隐私开关（契约 PrivacySettings，布尔而非 tinyint）。 */
  private toPrivacy(profile: AlumniProfile) {
    return {
      showInDirectory: Boolean(profile.showInDirectory),
      showCollege: Boolean(profile.showCollege),
      showIndustry: Boolean(profile.showIndustry),
      showRegion: Boolean(profile.showRegion),
      showDirection: Boolean(profile.showDirection),
      acceptContactRequests: Boolean(profile.acceptContactRequests),
      allowContactShare: Boolean(profile.allowContactShare),
    };
  }

  /** 我方视角的校友档案（契约 MyAlumniProfile：档案 + 隐私开关 + 自己的联系方式）。 */
  private toMyProfile(profile: AlumniProfile | null, contact: PrivateContact | null) {
    if (!profile) return null;
    return {
      userId: profile.userId,
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
      verified: Boolean(profile.verified),
      verifiedAt: profile.verifiedAt,
      contactVisible: Boolean(profile.allowContactShare),
      privacy: this.toPrivacy(profile),
      contactPhone: contact ? decryptValue(contact.phoneCipher, this.secret) : null,
      contactWechat: contact ? decryptValue(contact.wechatCipher, this.secret) : null,
      contactEmail: contact ? decryptValue(contact.emailCipher, this.secret) : null,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  /** 解密后的联系方式（仅本人可见）。 */
  private toContact(contact: PrivateContact | null) {
    return {
      contactPhone: contact ? decryptValue(contact.phoneCipher, this.secret) : null,
      contactWechat: contact ? decryptValue(contact.wechatCipher, this.secret) : null,
      contactEmail: contact ? decryptValue(contact.emailCipher, this.secret) : null,
    };
  }

  async getMe(userId: number) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');
    const profile = await this.profiles.findOne({
      where: { userId },
      relations: { region: true, industry: true },
    });
    const contact = await this.contacts.findOne({ where: { userId } });

    return {
      user: {
        id: user.id,
        openid: user.openid,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        role: null,
        status: user.status,
        stage: user.stage,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      },
      alumniProfile: this.toMyProfile(profile, contact),
      // 顶层同时保留，便于旧客户端
      privacy: profile ? this.toPrivacy(profile) : null,
      contact: this.toContact(contact),
      stage: user.stage,
    };
  }

  /** 我的校友档案（我方视角）。 */
  async getProfile(userId: number) {
    const profile = await this.profiles.findOne({
      where: { userId },
      relations: { region: true, industry: true },
    });
    const contact = await this.contacts.findOne({ where: { userId } });
    return this.toMyProfile(profile, contact);
  }

  /** 我的隐私开关。 */
  async getPrivacy(userId: number) {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) {
      return {
        showInDirectory: false,
        showCollege: false,
        showIndustry: false,
        showRegion: false,
        acceptContactRequests: false,
        allowContactShare: false,
      };
    }
    return this.toPrivacy(profile);
  }

  async updateProfile(userId: number, dto: UpdateProfileDto) {
    // ⚠️ 「资料 + 联系方式」是**两步写**，必须同事务（缺陷 #119）：
    //   原实现先提交资料、再写联系方式；第二步失败（加密/DB 错误）时，
    //   名字已经改了、手机号却没存，而接口返回 500 ——
    //   用户以为什么都没存，其实资料已经改了。
    return this.dataSource.transaction(async (manager) => {
      const profiles = manager.getRepository(AlumniProfile);
      const contacts = manager.getRepository(PrivateContact);

      const profile = await this.requireProfile(userId, profiles);
      if (dto.displayName !== undefined) profile.displayName = dto.displayName;
      if (dto.realName !== undefined) profile.realName = dto.realName;
      if (dto.college !== undefined) profile.college = dto.college;
      if (dto.degree !== undefined) profile.degree = dto.degree;
      if (dto.graduationYear !== undefined) profile.graduationYear = dto.graduationYear;
      if (dto.regionCode !== undefined) profile.regionCode = dto.regionCode;
      if (dto.industryCode !== undefined) profile.industryCode = dto.industryCode;
      if (dto.direction !== undefined) profile.direction = dto.direction;
      if (dto.intro !== undefined) profile.intro = dto.intro;
      profile.version += 1;
      await profiles.save(profile);

      // 联系方式随资料一起提交时一并落库（缺陷 #62）：
      // 之前 DTO 缺这三个字段 → whitelist 直接剥掉 → 用户以为保存成功、实际没存。
      // 落库仍走 updateContact 的加密写入路径，联系方式只以密文存储。
      if (
        dto.contactPhone !== undefined ||
        dto.contactWechat !== undefined ||
        dto.contactEmail !== undefined
      ) {
        await this.updateContact(
          userId,
          {
            contactPhone: dto.contactPhone,
            contactWechat: dto.contactWechat,
            contactEmail: dto.contactEmail,
          },
          manager,
        );
      }

      const contact = await contacts.findOne({ where: { userId } });
      return this.toMyProfile(profile, contact);
    });
  }

  async updatePrivacy(userId: number, dto: UpdatePrivacyDto) {
    const profile = await this.requireProfile(userId);
    if (dto.showInDirectory !== undefined) profile.showInDirectory = dto.showInDirectory;
    if (dto.showCollege !== undefined) profile.showCollege = dto.showCollege;
    if (dto.showIndustry !== undefined) profile.showIndustry = dto.showIndustry;
    if (dto.showRegion !== undefined) profile.showRegion = dto.showRegion;
    if (dto.showDirection !== undefined) profile.showDirection = dto.showDirection;
    if (dto.acceptContactRequests !== undefined) {
      profile.acceptContactRequests = dto.acceptContactRequests;
    }
    if (dto.allowContactShare !== undefined) profile.allowContactShare = dto.allowContactShare;
    profile.version += 1;
    await this.profiles.save(profile);
    return this.toPrivacy(profile);
  }

  async updateContact(userId: number, dto: UpdateContactDto, manager?: EntityManager) {
    // ⚠️ 事务内必须用 `manager.getRepository(...)`：
    // 注入的默认仓储走**另一条连接**，用它写数据会跳出事务（缺陷 #119）。
    const contacts = manager ? manager.getRepository(PrivateContact) : this.contacts;
    let contact = await contacts.findOne({ where: { userId } });
    if (!contact) {
      contact = contacts.create({ userId });
    }
    if (dto.contactPhone !== undefined) {
      contact.phoneCipher = encryptValue(dto.contactPhone, this.secret);
    }
    if (dto.contactWechat !== undefined) {
      contact.wechatCipher = encryptValue(dto.contactWechat, this.secret);
    }
    if (dto.contactEmail !== undefined) {
      contact.emailCipher = encryptValue(dto.contactEmail, this.secret);
    }
    await contacts.save(contact);
    return this.toContact(contact);
  }

  private async requireProfile(
    userId: number,
    profiles: Repository<AlumniProfile> = this.profiles,
  ): Promise<AlumniProfile> {
    const profile = await profiles.findOne({ where: { userId } });
    if (!profile) {
      const created = profiles.create({ userId, displayName: '校友' });
      return profiles.save(created);
    }
    return profile;
  }
}
