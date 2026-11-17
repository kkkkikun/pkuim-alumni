import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public } from '../../common/decorators';
import type { RequestUser } from '../../common/decorators';
import { UploadsService } from './uploads.service';
import { CreateUploadBodyDto } from './dto/upload.dto';

/** 与 UploadsService 的业务校验保持一致：10 MiB。 */
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

@ApiTags('文件上传')
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  /** 直传（管理后台）：multipart 一次完成登记与存储。 */
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_SIZE } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: '直传文件（multipart）' })
  async upload(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    @Body('visibility') visibility?: 'public' | 'private',
  ) {
    return this.uploadsService.upload(user.id, file, visibility === 'public' ? 'public' : 'private');
  }

  /** 登记（小程序）：先创建媒体记录，再取直传地址上传字节。 */
  @Post('records')
  @ApiOperation({ summary: '登记媒体资源并取得直传地址' })
  async createRecord(@CurrentUser() user: RequestUser, @Body() body: CreateUploadBodyDto) {
    const asset = await this.uploadsService.createAsset(user.id, body);
    const target = await this.uploadsService.getUploadTarget(asset.id, 'upload', user.id);
    return {
      id: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      size: asset.size,
      bucket: asset.bucket,
      objectKey: asset.objectKey,
      visibility: asset.visibility,
      url: null,
      uploadUrl: target.url,
      expiresIn: target.expiresIn,
      createdAt: asset.createdAt,
    };
  }

  /** 接收小程序直传的字节流（凭短期签名令牌）。 */
  @Public()
  @Post(':id/content')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_SIZE } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: '接收直传字节流' })
  async receiveContent(
    @Param('id', ParseIntPipe) id: number,
    @Query('token') token: string,
    @UploadedFile() file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ) {
    return this.uploadsService.receiveContent(id, token, file);
  }

  /** 直传地址 / 预览地址。intent=upload 返回直传地址，默认返回预签名下载地址。 */
  @Get(':id/url')
  @ApiOperation({ summary: '获取直传地址（intent=upload）或预签名下载地址' })
  url(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseIntPipe) id: number,
    @Query('intent') intent?: 'upload' | 'download',
  ) {
    // 传 user.id：私有资产只允许上传者本人取地址（防止他人拿到直传/下载地址）
    return this.uploadsService.getUploadTarget(
      id,
      intent === 'upload' ? 'upload' : 'download',
      user.id,
    );
  }
}
