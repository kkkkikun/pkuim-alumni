import type { IndustryDto, MediaAssetDto, RegionDto, UploadUrlResponse } from '@nmg/contracts';
import { ApiPaths } from '@nmg/contracts';
import { apiGet, apiUpload } from './http';

/** 地区字典 */
export function fetchRegions(): Promise<RegionDto[]> {
  return apiGet<RegionDto[]>(ApiPaths.systemRegions);
}

/** 行业字典 */
export function fetchIndustries(): Promise<IndustryDto[]> {
  return apiGet<IndustryDto[]>(ApiPaths.systemIndustries);
}

/** 上传文件，返回媒体资产（封面 / 证明材料） */
export function uploadMedia(file: File, extra?: { purpose?: string }): Promise<MediaAssetDto> {
  const form = new FormData();
  form.append('file', file);
  if (extra?.purpose) form.append('purpose', extra.purpose);
  return apiUpload<MediaAssetDto>(ApiPaths.uploads, form);
}

/** 获取私有媒体的临时访问地址（证明材料预览） */
export function fetchMediaUrl(mediaId: number): Promise<UploadUrlResponse> {
  return apiGet<UploadUrlResponse>(ApiPaths.uploadUrl(mediaId));
}
