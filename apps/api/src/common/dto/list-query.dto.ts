import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from './pagination.dto';
import { ToBoolean } from './transforms';

/**
 * 组合分页查询 DTO。
 *
 * 背景（重要）：Nest 的 ValidationPipe 依据 `@Query()` 参数的**运行时 metatype**
 * 判断是否做校验与转换。若写成 `PaginationQueryDto & { keyword?: string }` 这类
 * 交叉类型，metatype 会退化为 `Object`，导致：
 *   - class-transformer 不生效 → `page`/`pageSize` 仍是字符串或 undefined；
 *   - class-validator 不生效 → 非法参数被放行；
 *   - 最终 `skip(NaN)` 抛 TypeORMError，列表接口直接 500。
 *
 * 因此所有「分页 + 附加筛选」的查询都必须使用**具名类**并继承 PaginationQueryDto。
 */
export class ArticleListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '资讯分类 id' })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  categoryId?: number;
}

export class EventListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '地区编码' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  regionCode?: string;
}

/**
 * 管理端校友列表查询。
 *
 * 后台「校友管理」页面会传 keyword（姓名/学院/公众号模糊）、college、verified、
 * status（账号状态）、regionCode、industryCode、graduationYear 等筛选条件。
 * 这些参数服务端必须**真正支持** —— 否则筛选框只是摆设：
 * 前端照常发请求、服务端照常返回 200，但结果不受筛选影响。
 * 详见 docs/KNOWN-ISSUES.md #59。
 */
export class AdminAlumniListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsString()
  @MaxLength(64)
  @IsOptional()
  keyword?: string;

  @ApiPropertyOptional()
  @IsIn(['logged_in', 'pending_review', 'verified'])
  @MaxLength(32)
  @IsOptional()
  stage?: 'logged_in' | 'pending_review' | 'verified';

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(32)
  @IsOptional()
  regionCode?: string;

  @ApiPropertyOptional({ description: '学院（模糊匹配）' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  college?: string;

  @ApiPropertyOptional({ description: '是否已认证' })
  // 查询参数只能传字符串：'false' 必须映射成 false。
  // ⚠️ 不能用 @Type(() => Boolean) —— 它的转换是 !!value 语义，'false' 会变成 true。
  @ToBoolean()
  @IsBoolean()
  @IsOptional()
  verified?: boolean;

  @ApiPropertyOptional({ enum: ['active', 'disabled', 'locked'], description: '账号状态' })
  @IsIn(['active', 'disabled', 'locked'])
  @IsOptional()
  status?: 'active' | 'disabled' | 'locked';

  @ApiPropertyOptional({ description: '行业编码' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  industryCode?: string;

  @ApiPropertyOptional({ description: '毕业年份' })
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2100)
  @IsOptional()
  graduationYear?: number;
}

export class AdminVerificationListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['pending', 'needs_more_material', 'approved', 'rejected', 'resubmitted'],
    description: '认证状态',
  })
  @IsIn(['pending', 'needs_more_material', 'approved', 'rejected', 'resubmitted'])
  @IsOptional()
  status?: 'pending' | 'needs_more_material' | 'approved' | 'rejected' | 'resubmitted';

  /** 关键字：申请人姓名 / 学院 / 学号（后台「认证审核」页的搜索框） */
  @ApiPropertyOptional({ description: '申请人姓名 / 学院 / 学号关键字' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  keyword?: string;
}

export class AdminResourceListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['draft', 'pending', 'published', 'rejected', 'offline', 'withdrawn'],
    description: '资源状态',
  })
  @IsIn(['draft', 'pending', 'published', 'rejected', 'offline', 'withdrawn'])
  @IsOptional()
  status?: 'draft' | 'pending' | 'published' | 'rejected' | 'offline' | 'withdrawn';

  /** 关键字：标题 / 正文（后台「资源审核」页的搜索框） */
  @ApiPropertyOptional({ description: '标题 / 正文关键字' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  keyword?: string;

  @ApiPropertyOptional({ enum: ['resource', 'demand'] })
  @IsIn(['resource', 'demand'])
  @IsOptional()
  type?: 'resource' | 'demand';
}

export class AdminArticleListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['draft', 'published', 'offline'],
    description: '资讯状态',
  })
  @IsIn(['draft', 'published', 'offline'])
  @IsOptional()
  status?: 'draft' | 'published' | 'offline';

  /** 关键字：标题 / 摘要（后台「资讯管理」页的搜索框） */
  @ApiPropertyOptional({ description: '标题 / 摘要关键字' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  keyword?: string;

  @ApiPropertyOptional({ description: '资讯分类 id' })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  categoryId?: number;
}

export class AdminNoticeListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['draft', 'published', 'offline'],
    description: '公告状态',
  })
  @IsIn(['draft', 'published', 'offline'])
  @IsOptional()
  status?: 'draft' | 'published' | 'offline';

  /** 关键字：标题 / 正文（后台「公告管理」页的搜索框） */
  @ApiPropertyOptional({ description: '标题 / 正文关键字' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  keyword?: string;
}

/**
 * 管理端活动列表查询。
 *
 * 后台「活动管理」页提供关键字与状态两个筛选条件，服务端必须真正支持 ——
 * 否则筛选框只是摆设。详见 docs/KNOWN-ISSUES.md #63。
 */
export class AdminEventListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '标题关键字' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  keyword?: string;

  @ApiPropertyOptional({
    enum: ['draft', 'published', 'closed', 'cancelled'],
    description: '活动状态',
  })
  @IsIn(['draft', 'published', 'closed', 'cancelled'])
  @IsOptional()
  status?: 'draft' | 'published' | 'closed' | 'cancelled';
}

/**
 * 管理端审计日志列表查询。
 *
 * 后台「审计日志」页提供操作人 / 操作类型 / 起止时间四个筛选条件。
 * 详见 docs/KNOWN-ISSUES.md #63。
 */
export class AdminActionLogQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '操作人 id' })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  adminId?: number;

  @ApiPropertyOptional({ description: '操作类型' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  action?: string;

  @ApiPropertyOptional({ description: '起始日期（YYYY-MM-DD）' })
  @IsString()
  @MaxLength(10)
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({ description: '截止日期（YYYY-MM-DD）' })
  @IsString()
  @MaxLength(10)
  @IsOptional()
  endDate?: string;
}

/**
 * 管理员账号列表查询。
 *
 * 管理后台的「系统管理 · 管理员账号」页面会传 `keyword`（账号 / 姓名模糊）
 * 与 `status`（账号状态）两个筛选条件，服务端必须真正支持 ——
 * 否则筛选框是摆设（前端会照常发请求，但结果不受影响）。
 */
export class AdminUserListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '账号或姓名关键字' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  keyword?: string;

  // ⚠️ 管理员账号表 `admin_users.status` 的 ENUM 只有 ('active','disabled')（见 DATABASE-DESIGN.md §8），
  // 没有 'locked'。此前这里放行了 'locked' → 后台「账号状态 = 已锁定」这个筛选项
  // **永远筛不出任何行**，是个摆设筛选项（缺陷 #114）。
  @ApiPropertyOptional({ enum: ['active', 'disabled'] })
  @IsIn(['active', 'disabled'])
  @IsOptional()
  status?: 'active' | 'disabled';
}
