/**
 * 系统字典服务：地区、行业、资讯分类。
 * 字典结果缓存在全局 store，避免各页面重复请求。
 */

import { getState, setState } from '../store';
import { ApiPaths } from './paths';
import { get } from './request';
import type { ArticleCategoryDto, IndustryDto, RegionDto } from '../types';

/** 全部地区（含“区外校友”） */
export async function fetchRegions(force = false): Promise<RegionDto[]> {
  if (!force && getState().regions.length) {
    return getState().regions;
  }
  const regions = await get<RegionDto[]>(ApiPaths.systemRegions, undefined, { auth: false });
  setState({ regions: regions || [] });
  return regions || [];
}

/** 行业列表 */
export async function fetchIndustries(force = false): Promise<IndustryDto[]> {
  if (!force && getState().industries.length) {
    return getState().industries;
  }
  const industries = await get<IndustryDto[]>(ApiPaths.systemIndustries, undefined, { auth: false });
  setState({ industries: industries || [] });
  return industries || [];
}

/** 资讯分类 */
export async function fetchCategories(force = false): Promise<ArticleCategoryDto[]> {
  if (!force && getState().categories.length) {
    return getState().categories;
  }
  const categories = await get<ArticleCategoryDto[]>(ApiPaths.articleCategories, undefined, { auth: false });
  setState({ categories: categories || [] });
  return categories || [];
}

/** 预热字典（首页启动时调用） */
export async function preloadDictionaries(): Promise<void> {
  const tasks: Promise<unknown>[] = [fetchRegions(), fetchIndustries(), fetchCategories()];
  const results = await Promise.allSettled(tasks);
  results.forEach((result) => {
    if (result.status === 'rejected') {
      console.warn('[system] 字典预加载部分失败', result.reason);
    }
  });
}

/** 按 code 查名称 */
export function regionName(code: string | null | undefined): string {
  if (!code) {
    return '';
  }
  const hit = getState().regions.find((item) => item.code === code);
  return hit ? hit.name : code;
}

export function industryName(code: string | null | undefined): string {
  if (!code) {
    return '';
  }
  const hit = getState().industries.find((item) => item.code === code);
  return hit ? hit.name : code;
}
