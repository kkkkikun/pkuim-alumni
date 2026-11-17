import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../../common/decorators';
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
  ) {}

  @Public()
  @Get('regions')
  @ApiOperation({ summary: '盟市字典（含已公开校友数）' })
  async listRegions() {
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
    return rows.map((region) => ({
      code: region.code,
      name: region.name,
      level: region.level,
      sortOrder: region.sortOrder,
      alumniCount: countMap.get(region.code) ?? 0,
    }));
  }

  @Public()
  @Get('industries')
  @ApiOperation({ summary: '行业字典（含已公开校友数）' })
  async listIndustries() {
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
    return rows.map((industry) => ({
      code: industry.code,
      name: industry.name,
      sortOrder: industry.sortOrder,
      alumniCount: countMap.get(industry.code) ?? 0,
    }));
  }

  @Public()
  @Get('settings')
  @ApiOperation({ summary: '公开的系统配置项' })
  async listSettings() {
    const rows = await this.settings.find({ order: { key: 'ASC' } });
    return rows.map((row) => ({
      key: row.key,
      value: row.value,
      description: row.description,
    }));
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
