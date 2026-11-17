import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from './common/decorators';

@ApiTags('健康检查')
@Controller()
export class AppController {
  @Public()
  @Get('healthz')
  @ApiOperation({ summary: '存活探针（容器健康检查）' })
  health() {
    return { status: 'ok', service: 'nmg-api', timestamp: new Date().toISOString() };
  }
}
