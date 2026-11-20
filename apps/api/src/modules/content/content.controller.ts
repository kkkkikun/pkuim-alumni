import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { ArticleListQueryDto } from '../../common/dto/list-query.dto';
import { Public } from '../../common/decorators';
import { ContentService } from './content.service';

@ApiTags('内容')
@Controller()
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  @Public()
  @Get('articles')
  @ApiOperation({ summary: '资讯列表（正文为摘要）' })
  listArticles(@Query() query: ArticleListQueryDto) {
    // ⚠️ 公开列表只返回正文**摘要**（`body` 是 MEDIUMTEXT，
    //    pageSize=100 时单次响应可达数十 MB）。完整正文走 `GET /articles/:id`。
    return this.contentService.listArticles(
      {
        page: query.page,
        pageSize: query.pageSize,
        categoryId: query.categoryId,
      },
      { bodyExcerpt: true },
    );
  }

  @Public()
  @Get('articles/categories')
  @ApiOperation({ summary: '资讯分类' })
  listCategories() {
    return this.contentService.listCategories();
  }

  @Public()
  @Get('articles/:id')
  @ApiOperation({ summary: '资讯详情' })
  articleDetail(@Param('id', ParseIntPipe) id: number) {
    return this.contentService.articleDetail(id);
  }

  @Public()
  @Get('notices')
  @ApiOperation({ summary: '通知公告列表（正文为摘要）' })
  listNotices(@Query() query: PaginationQueryDto) {
    // ⚠️ 同 `GET /articles`：公开列表只返回正文摘要，完整正文走详情接口。
    return this.contentService.listNotices(
      { page: query.page, pageSize: query.pageSize },
      { bodyExcerpt: true },
    );
  }

  @Public()
  @Get('notices/:id')
  @ApiOperation({ summary: '公告详情' })
  noticeDetail(@Param('id', ParseIntPipe) id: number) {
    return this.contentService.noticeDetail(id);
  }

  @Public()
  @Get('home/feed')
  @ApiOperation({ summary: '首页聚合数据' })
  homeFeed() {
    return this.contentService.homeFeed();
  }
}
