import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
import type { RequestUser } from '../../common/decorators';
import { RequireAlumniStage } from '../../common/guards/alumni-stage.guard';
import { DirectoryService } from './directory.service';
import { DirectoryQueryDto } from './dto/directory.dto';

@ApiTags('通讯录')
@Controller('directory')
export class DirectoryController {
  constructor(private readonly directoryService: DirectoryService) {}

  @Get()
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '通讯录查询（仅已认证且授权公开的校友）' })
  list(@CurrentUser() user: RequestUser, @Query() query: DirectoryQueryDto) {
    return this.directoryService.list(user.id, query);
  }

  @Get(':id')
  @RequireAlumniStage('verified')
  @ApiOperation({ summary: '校友公开名片' })
  detail(@CurrentUser() user: RequestUser, @Param('id', ParseIntPipe) id: number) {
    return this.directoryService.detail(user.id, id);
  }
}
