import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../../common/decorators';
import { CacheKeys } from '../../common/constants';
import { TtlCacheService } from '../../common/services/ttl-cache.service';
import { Industry, Region } from '../../database/entities/dictionary.entity';
import { AlumniProfile } from '../../database/entities/alumni.entity';
import { User } from '../../database/entities/user.entity';
import { SystemSetting } from '../../database/entities/system.entity';

@ApiTags('系统')
@Controller('system')
export class SystemController {
  constructor(
    @InjectRepository(Region) private readonly regions: Repository<Region>,
    @InjectRepository(Industry) private readonly industries: Repository<Industry>,
    @InjectRepository(AlumniProfile) private readonly profiles: Repository<AlumniProfile>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(SystemSetting) private readonly settings: Repository<SystemSetting>,
    private readonly cache: TtlCacheService,
  ) {}

  @Public()
  @Get('regions')
  @ApiOperation({ summary: '盟市字典（含已公开校友数）' })
  async listRegions() {
    // ⚠️ 第三轮：此前每次请求都做一次 `alumni_profiles JOIN users` 的**全表 GROUP BY**，
    //    小程序冷启动必打 3 条（地区 / 行业 / 分类）—— 每条都是一次全表聚合。
    //    现在走进程内 TTL 缓存（口径见 docs/SECURITY.md 第 2.1 节）。
    const cached = this.cache.get<unknown[]>(CacheKeys.regions);
    if (cached) return cached;
    const counts = await this.profiles
      .createQueryBuilder('p')
      .innerJoin(User, 'u', 'u.id = p.userId')
      .where('p.showInDirectory = :visible', { visible: true })
      .andWhere('u.stage = :stage', { stage: 'verified' })
      .select('p.regionCode', 'regionCode')
      .addSelect('COUNT(*)', 'total')
      .groupBy('p.regionCode')
      .getRawMany<{ regionCode: string | null; total: string }>();
    const countMap = new Map(counts.map((item) => [item.regionCode, Number(item.total)]));
    const rows = await this.regions.find({ order: { sortOrder: 'ASC' } });
    const result = rows.map((region) => ({
      code: region.code,
      name: region.name,
      level: region.level,
      sortOrder: region.sortOrder,
      alumniCount: countMap.get(region.code) ?? 0,
    }));
    this.cache.set(CacheKeys.regions, result, this.cache.dictionaryTtlSeconds);
    return result;
  }

  @Public()
  @Get('industries')
  @ApiOperation({ summary: '行业字典（含已公开校友数）' })
  async listIndustries() {
    // ⚠️ 同 `listRegions`：全表聚合 → 进程内 TTL 缓存。
    const cached = this.cache.get<unknown[]>(CacheKeys.industries);
    if (cached) return cached;
    const counts = await this.profiles
      .createQueryBuilder('p')
      .innerJoin(User, 'u', 'u.id = p.userId')
      .where('p.showInDirectory = :visible', { visible: true })
      .andWhere('u.stage = :stage', { stage: 'verified' })
      .select('p.industryCode', 'industryCode')
      .addSelect('COUNT(*)', 'total')
      .groupBy('p.industryCode')
      .getRawMany<{ industryCode: string | null; total: string }>();
    const countMap = new Map(counts.map((item) => [item.industryCode, Number(item.total)]));
    const rows = await this.industries.find({ order: { sortOrder: 'ASC' } });
    const result = rows.map((industry) => ({
      code: industry.code,
      name: industry.name,
      sortOrder: industry.sortOrder,
      alumniCount: countMap.get(industry.code) ?? 0,
    }));
    this.cache.set(CacheKeys.industries, result, this.cache.dictionaryTtlSeconds);
    return result;
  }

  @Public()
  @Get('settings')
  @ApiOperation({ summary: '公开的系统配置项' })
  async listSettings() {
    // ⚠️ 第三轮：公开设置项同样走 TTL 缓存；
    //    `PUT /admin/settings` 写入后会**主动失效**这条缓存。
    const cached = this.cache.get<unknown[]>(CacheKeys.publicSettings);
    if (cached) return cached;
    const rows = await this.settings.find({ order: { key: 'ASC' } });
    const result = rows.map((row) => ({
      key: row.key,
      value: row.value,
      description: row.description,
    }));
    this.cache.set(CacheKeys.publicSettings, result, this.cache.dictionaryTtlSeconds);
    return result;
  }

  @Public()
  @Get('health')
  @ApiOperation({ summary: '健康检查（依赖连通性）' })
  async health() {
    const checks: Record<string, string> = {};
    try {
      await this.users.query('SELECT 1');
      checks.database = 'ok';
    } catch (error) {
      checks.database = `error: ${(error as Error).message}`;
    }
    const healthy = Object.values(checks).every((value) => value === 'ok');
    return { status: healthy ? 'ok' : 'degraded', checks, timestamp: new Date().toISOString() };
  }
}
