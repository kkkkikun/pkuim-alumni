import { ApiPaths } from '@nmg/contracts';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../helpers';

/**
 * 契约 ↔ 路由一致性测试。
 *
 * 契约（packages/contracts/src/api.ts 的 ApiPaths）是前后端唯一事实来源。
 * 本用例把 ApiPaths 里声明的每一条路径与 Nest 实际注册的路由做比对，
 * 目的：避免出现「小程序按契约调用 → 后端 404」这类前后端割裂。
 *
 * 约定：
 * - ApiPaths 中的函数式路径用**样本 id** 求值；
 * - 样本参数个数按函数的**参数个数**给足
 *   （多参数路径如 `/admin/verifications/{id}/attachments/{mediaId}/url` 需要两个）；
 * - 与 swagger 的 `{占位符}` 段做**逐段匹配**：数字段与 `{xxx}` 段互相当作通配；
 * - 只校验路径是否存在（不校验 HTTP 方法），方法由具体业务用例覆盖。
 */
describe('契约 · 路由一致性 (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  /** 是否是 swagger 的路径占位符段（{id} / {mediaId} …） */
  function isTemplateSegment(segment: string): boolean {
    return /^\{\w+\}$/.test(segment);
  }

  /** 逐段比较：数字段与占位符段互相当作通配 */
  function pathMatches(actual: string, template: string): boolean {
    const left = actual.replace(/^\/api\/v1/, '').split('/');
    const right = template.replace(/^\/api\/v1/, '').split('/');
    if (left.length !== right.length) return false;
    return left.every((segment, index) => {
      const other = right[index];
      return (
        segment === other || isTemplateSegment(segment) || isTemplateSegment(other)
      );
    });
  }

  it('ApiPaths 中声明的所有路径都已在服务端注册', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('contract-audit').build(),
    );
    const registered = Object.keys(document.paths ?? {});

    const missing: string[] = [];
    for (const [name, raw] of Object.entries(ApiPaths)) {
      // 函数式路径按**参数个数**给足样本参数（多参数路径需要 id + mediaId）
      const path =
        typeof raw === 'function'
          ? (raw as (...args: number[]) => string)(...[1, 2, 3, 4, 5].slice(0, raw.length))
          : (raw as string);
      const normalized = path.replace(/^\/api\/v1/, '');
      const hit = registered.some((template) => pathMatches(normalized, template));
      if (!hit) {
        missing.push(`${name} → ${normalized}`);
      }
    }

    expect(missing).toEqual([]);
  });
});
