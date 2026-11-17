import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Client } from 'minio';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Repository } from 'typeorm';
import { MediaAsset } from '../../database/entities/system.entity';
import {
  ALLOWED_EXTENSIONS,
  CreateUploadBodyDto,
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_SIZE,
} from './dto/upload.dto';

const ALLOWED_MIME = new Set<string>(ALLOWED_MIME_TYPES);
const ALLOWED_EXT = new Set<string>(ALLOWED_EXTENSIONS);

const MAX_SIZE = MAX_UPLOAD_SIZE;
const UPLOAD_TOKEN_TTL_SECONDS = 600;

/** @deprecated 请使用 `CreateUploadBodyDto`（带 class-validator 校验，缺陷 #88） */
export type CreateUploadBody = CreateUploadBodyDto;

@Injectable()
export class UploadsService implements OnModuleInit {
  private readonly logger = new Logger(UploadsService.name);
  private client: Client | null = null;

  constructor(
    @InjectRepository(MediaAsset) private readonly assets: Repository<MediaAsset>,
    private readonly config: ConfigService,
  ) {}

  /**
   * 启动时确保存储桶存在。
   *
   * 桶不存在时 MinIO 会返回 NoSuchBucket，导致**所有上传失败**，
   * 且报错信息难以定位。这里在启动阶段幂等创建 public / private 两个桶。
   * MinIO 不可用时只告警不阻断启动（对象存储故障不应让整个 API 起不来）。
   */
  async onModuleInit(): Promise<void> {
    try {
      const client = this.getMinio();
      for (const bucket of [this.publicBucket, this.privateBucket]) {
        const exists = await client.bucketExists(bucket).catch(() => false);
        if (!exists) {
          await client.makeBucket(bucket);
          this.logger.log(`已创建存储桶：${bucket}`);
        }
      }
    } catch (error) {
      this.logger.warn(
        `对象存储不可用，跳过建桶（上传功能将不可用）：${(error as Error).message}`,
      );
    }
  }

  private getMinio(): Client {
    if (!this.client) {
      this.client = new Client({
        endPoint: this.config.get<string>('minio.endpoint', '127.0.0.1'),
        port: this.config.get<number>('minio.port', 9000),
        useSSL: this.config.get<boolean>('minio.useSSL', false),
        accessKey: this.config.get<string>('minio.accessKey', ''),
        secretKey: this.config.get<string>('minio.secretKey', ''),
      });
    }
    return this.client;
  }

  private get privateBucket(): string {
    return this.config.get<string>('minio.privateBucket', 'nmg-private');
  }

  private get publicBucket(): string {
    return this.config.get<string>('minio.publicBucket', 'nmg-public');
  }

  private get secret(): string {
    return this.config.get<string>('app.jwtSecret', 'change-me');
  }

  /** 外部可访问的 API 地址（小程序直传用）。 */
  private get publicApiBase(): string {
    return this.config.get<string>('app.publicApiBase', 'http://127.0.0.1:18081');
  }

  /* ------------------------------------------------------------------ */
  /* 路径一：直传（管理后台，multipart 一次到位）                          */
  /* ------------------------------------------------------------------ */

  async upload(
    uploaderId: number,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    visibility: 'public' | 'private' = 'private',
  ): Promise<Record<string, unknown>> {
    this.assertFile(file.originalname, file.mimetype, file.size);
    const asset = await this.createAsset(uploaderId, {
      fileName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      visibility,
    });
    await this.putObject(asset, file.buffer, file.mimetype);
    return this.toDto(asset, visibility === 'public' ? await this.presign(asset, 300) : null);
  }

  /* ------------------------------------------------------------------ */
  /* 路径二：登记 + 直传地址（小程序，两步上传）                          */
  /* ------------------------------------------------------------------ */

  async createAsset(
    uploaderId: number,
    body: CreateUploadBodyDto,
  ): Promise<MediaAsset> {
    this.assertFile(body.fileName, body.mimeType, body.size);
    const visibility = body.visibility === 'public' ? 'public' : 'private';
    const bucket = visibility === 'public' ? this.publicBucket : this.privateBucket;
    const objectKey = `${visibility}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}${this.extensionOf(body.fileName)}`;
    return this.assets.save(
      this.assets.create({
        fileName: body.fileName,
        mimeType: body.mimeType,
        size: body.size,
        bucket,
        objectKey,
        visibility,
        uploaderId,
      }),
    );
  }

  /**
   * 返回直传地址：
   * - intent=upload：小程序使用，返回带短期签名的 API 直传地址（避免客户端持有 MinIO 凭据）
   * - intent=download（默认）：返回 MinIO 预签名下载地址，用于管理端预览
   *
   * **归属校验**：私有资产只允许上传者本人取地址。
   * 取不到地址就等于拿不到文件 —— 尤其 `intent=upload` 的直传地址带写入能力，
   * 泄露出去等于允许他人覆盖别人的文件。
   */
  async getUploadTarget(
    assetId: number,
    intent: 'upload' | 'download' = 'download',
    requesterId?: number,
  ): Promise<{ url: string; expiresIn: number }> {
    const asset = await this.requireAsset(assetId);
    this.assertOwnership(asset, requesterId, intent);
    if (intent === 'upload') {
      const token = this.signUploadToken(asset.id);
      return {
        url: `${this.publicApiBase}/api/v1/uploads/${asset.id}/content?token=${token}`,
        expiresIn: UPLOAD_TOKEN_TTL_SECONDS,
      };
    }
    return { url: await this.presign(asset, 300), expiresIn: 300 };
  }

  /**
   * 私有资产的归属校验。
   *
   * - 下载（intent=download）：公开资产任何登录用户都可取地址；私有资产只有上传者本人可取；
   * - **写入（intent=upload）：无论公开还是私有，都只允许上传者本人** ——
   *   直传地址不是下载地址，它是**带写入能力的签名地址**，
   *   拿到它就能把那个对象**覆盖掉**。
   *   缺陷 #104：修复前这里对 public 资产直接放行，
   *   于是「乙 → 取甲的 public 资产的 upload 地址 → 覆盖甲的文件」成为可能。
   * - 内部调用（未传 requesterId）不做限制。
   *
   * 失败一律抛 **404** 而非 403 —— 与「通讯录未公开资料返回 404」的既有取舍一致，
   * 避免通过状态码泄露「该文件是否存在」。
   */
  private assertOwnership(
    asset: MediaAsset,
    requesterId?: number,
    intent: 'upload' | 'download' = 'download',
  ): void {
    if (requesterId === undefined) return;
    if (intent === 'upload') {
      // 写入能力绝不因「公开可见」而外泄
      if (asset.uploaderId !== requesterId) {
        throw new NotFoundException('文件不存在');
      }
      return;
    }
    if (asset.visibility === 'public') return;
    if (asset.uploaderId !== requesterId) {
      throw new NotFoundException('文件不存在');
    }
  }

  /** 接收小程序直传的字节流并写入对象存储。 */
  async receiveContent(
    assetId: number,
    token: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ): Promise<Record<string, unknown>> {
    const asset = await this.requireAsset(assetId);
    if (!this.verifyUploadToken(asset.id, token)) {
      throw new UnauthorizedException('上传凭据无效或已过期');
    }
    this.assertFile(file.originalname, file.mimetype, file.size);
    await this.putObject(asset, file.buffer, file.mimetype);
    asset.size = file.size;
    asset.mimeType = file.mimetype;
    await this.assets.save(asset);
    return this.toDto(asset, null);
  }

  async urlFor(assetId: number, requesterId?: number): Promise<{ url: string; expiresIn: number }> {
    return this.getUploadTarget(assetId, 'download', requesterId);
  }

  /* ------------------------------------------------------------------ */

  private async requireAsset(assetId: number): Promise<MediaAsset> {
    const asset = await this.assets.findOne({ where: { id: assetId } });
    if (!asset) throw new NotFoundException('文件不存在');
    return asset;
  }

  private async putObject(
    asset: MediaAsset,
    buffer: Buffer,
    mimeType: string,
  ): Promise<void> {
    await this.getMinio().putObject(asset.bucket, asset.objectKey, buffer, buffer.length, {
      'Content-Type': mimeType,
    });
  }

  private async presign(asset: MediaAsset, expiresInSeconds: number): Promise<string> {
    return this.getMinio().presignedGetObject(asset.bucket, asset.objectKey, expiresInSeconds);
  }

  private toDto(asset: MediaAsset, url: string | null): Record<string, unknown> {
    return {
      id: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      size: asset.size,
      bucket: asset.bucket,
      objectKey: asset.objectKey,
      visibility: asset.visibility,
      url,
      createdAt: asset.createdAt,
    };
  }

  private assertFile(fileName: string, mimeType: string, size: number): void {
    if (!fileName || !mimeType) throw new BadRequestException('缺少文件信息');
    if (!ALLOWED_MIME.has(mimeType)) {
      throw new BadRequestException(`不支持的文件类型: ${mimeType}`);
    }
    if (!ALLOWED_EXT.has(this.extensionOf(fileName))) {
      throw new BadRequestException(`不支持的文件扩展名: ${this.extensionOf(fileName)}`);
    }
    if (size > MAX_SIZE) throw new BadRequestException('文件超过 10MB 上限');
  }

  private extensionOf(filename: string): string {
    const index = filename.lastIndexOf('.');
    return index === -1 ? '' : filename.slice(index).toLowerCase();
  }

  private signUploadToken(assetId: number): string {
    const expiresAt = Math.floor(Date.now() / 1000) + UPLOAD_TOKEN_TTL_SECONDS;
    const payload = `${assetId}.${expiresAt}`;
    const signature = createHmac('sha256', this.secret).update(payload).digest('hex');
    return `${expiresAt}.${signature}`;
  }

  private verifyUploadToken(assetId: number, token: string): boolean {
    const [expiresAtRaw, signature] = (token ?? '').split('.');
    if (!expiresAtRaw || !signature) return false;
    const expiresAt = Number(expiresAtRaw);
    if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return false;
    const expected = createHmac('sha256', this.secret)
      .update(`${assetId}.${expiresAt}`)
      .digest('hex');
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
