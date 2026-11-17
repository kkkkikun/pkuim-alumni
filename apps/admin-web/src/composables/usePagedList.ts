import { ref, shallowRef, type Ref } from 'vue';
import type { PageMeta, PageResult } from '@nmg/contracts';
import { errorMessage } from '@/api/http';

export interface PagedParams {
  page: number;
  pageSize: number;
}

/**
 * 列表页通用分页逻辑：
 * - 统一的 loading / error / empty 状态；
 * - 分页参数与 PageResult.meta 对齐；
 * - 请求序号防止旧响应覆盖新响应。
 */
export function usePagedList<T>(
  fetcher: (params: PagedParams) => Promise<PageResult<T>>,
  options: { immediate?: boolean; pageSize?: number } = {},
) {
  const items = shallowRef<T[]>([]);
  const meta = ref<PageMeta>({
    page: 1,
    pageSize: options.pageSize ?? 20,
    total: 0,
    totalPages: 0,
  });
  const loading = ref(false);
  const error = ref<string | null>(null);
  const page = ref(1);
  const pageSize = ref(options.pageSize ?? 20);

  let sequence = 0;

  async function load(): Promise<void> {
    const current = ++sequence;
    loading.value = true;
    error.value = null;
    try {
      const result = await fetcher({ page: page.value, pageSize: pageSize.value });
      if (current !== sequence) return;
      items.value = result.items;
      meta.value = result.meta;
    } catch (e) {
      if (current !== sequence) return;
      items.value = [];
      error.value = errorMessage(e);
    } finally {
      if (current === sequence) loading.value = false;
    }
  }

  async function search(): Promise<void> {
    page.value = 1;
    await load();
  }

  async function changePage(value: number): Promise<void> {
    page.value = value;
    await load();
  }

  async function changePageSize(value: number): Promise<void> {
    pageSize.value = value;
    page.value = 1;
    await load();
  }

  if (options.immediate !== false) {
    void load();
  }

  return {
    items: items as Ref<T[]>,
    meta,
    loading,
    error,
    page,
    pageSize,
    load,
    search,
    changePage,
    changePageSize,
  };
}
