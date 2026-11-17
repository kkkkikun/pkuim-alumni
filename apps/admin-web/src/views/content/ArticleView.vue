<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next';
import type { ArticleCategoryDto, ArticleDto } from '@nmg/contracts';
import {
  createArticle,
  createCategory,
  deleteArticle,
  fetchArticles,
  fetchCategories,
  setArticleStatus,
  updateArticle,
  updateCategory,
  type AdminArticleQuery,
  type UpdateArticleBody,
} from '@/api/admin';
import { usePagedList } from '@/composables/usePagedList';
import { debounce } from '@/utils/debounce';
import { CONTENT_STATUS_LABELS, CONTENT_STATUS_THEMES, formatDateTime } from '@/utils/format';
import PageHeader from '@/components/PageHeader.vue';
import StateBox from '@/components/StateBox.vue';
import PagerBar from '@/components/PagerBar.vue';
import AppIcon from '@/components/AppIcon.vue';
import CoverUploader from '@/components/CoverUploader.vue';

const filters = reactive({
  keyword: '',
  status: '' as '' | ArticleDto['status'],
  categoryId: '' as '' | number,
});

const categories = ref<ArticleCategoryDto[]>([]);
const categoryOptions = computed(() => [
  { label: '全部分类', value: '' },
  ...categories.value.map((item) => ({ label: item.name, value: item.id })),
]);
const categorySelectOptions = computed(() =>
  categories.value.map((item) => ({ label: item.name, value: item.id })),
);

function buildQuery(page: number, pageSize: number): AdminArticleQuery {
  const query: AdminArticleQuery = { page, pageSize };
  const keyword = filters.keyword.trim();
  if (keyword) query.keyword = keyword;
  if (filters.status) query.status = filters.status;
  if (filters.categoryId !== '') query.categoryId = Number(filters.categoryId);
  return query;
}

const list = usePagedList<ArticleDto>((params) => fetchArticles(buildQuery(params.page, params.pageSize)));

const columns = [
  { colKey: 'title', title: '标题', width: 200 },
  { colKey: 'categoryName', title: '分类', width: 100 },
  { colKey: 'status', title: '状态', width: 90 },
  { colKey: 'publishedAt', title: '发布时间', width: 140 },
  { colKey: 'viewCount', title: '阅读', width: 80 },
  { colKey: 'operation', title: '操作', width: 200 },
];

const statusOptions = [
  { label: '全部状态', value: '' },
  { label: CONTENT_STATUS_LABELS.draft, value: 'draft' },
  { label: CONTENT_STATUS_LABELS.published, value: 'published' },
  { label: CONTENT_STATUS_LABELS.offline, value: 'offline' },
];

const articleStatusOptions = [
  { label: '草稿', value: 'draft' },
  { label: '已发布', value: 'published' },
];

const dialogVisible = ref(false);
const editingId = ref<number | null>(null);
const saving = ref(false);
const form = reactive({
  title: '',
  categoryId: undefined as number | undefined,
  summary: '',
  body: '',
  status: 'draft' as 'draft' | 'published',
  coverMediaId: null as number | null,
  coverUrl: null as string | null,
});
const errors = reactive<Record<string, string>>({});

const categoryVisible = ref(false);
const categoryName = ref('');
const categorySlug = ref('');
const categorySort = ref(0);
const categorySaving = ref(false);
const editingCategoryId = ref<number | null>(null);

const debouncedSearch = debounce(() => {
  void list.search();
}, 400);

function onKeywordInput(): void {
  debouncedSearch();
}

function statusText(row: unknown): string {
  const item = row as ArticleDto;
  return CONTENT_STATUS_LABELS[item.status] ?? item.status;
}

function statusTheme(row: unknown): string {
  const item = row as ArticleDto;
  return CONTENT_STATUS_THEMES[item.status] ?? 'default';
}

async function loadCategories(): Promise<void> {
  try {
    categories.value = await fetchCategories();
  } catch (error) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  }
}

function resetForm(): void {
  form.title = '';
  form.categoryId = undefined;
  form.summary = '';
  form.body = '';
  form.status = 'draft';
  form.coverMediaId = null;
  form.coverUrl = null;
  Object.keys(errors).forEach((key) => delete errors[key]);
}

function openCreate(): void {
  editingId.value = null;
  resetForm();
  dialogVisible.value = true;
}

function openEdit(row: unknown): void {
  const item = row as ArticleDto;
  editingId.value = item.id;
  resetForm();
  form.title = item.title;
  form.categoryId = item.categoryId ?? undefined;
  form.summary = item.summary ?? '';
  form.body = item.body;
  form.status = item.status === 'published' ? 'published' : 'draft';
  form.coverMediaId = item.coverMediaId;
  dialogVisible.value = true;
}

async function save(): Promise<void> {
  errors.title = form.title.trim() ? '' : '请填写资讯标题';
  errors.body = form.body.trim() ? '' : '请填写资讯正文';
  if (errors.title || errors.body) {
    MessagePlugin.warning('请先完善表单信息');
    return;
  }
  saving.value = true;
  const body: UpdateArticleBody = {
    title: form.title.trim(),
    categoryId: form.categoryId,
    summary: form.summary.trim() || undefined,
    body: form.body,
    status: form.status,
    coverMediaId: form.coverMediaId ?? undefined,
  };
  try {
    if (editingId.value) {
      await updateArticle(editingId.value, body);
      MessagePlugin.success('资讯已更新');
    } else {
      await createArticle({
        title: form.title.trim(),
        body: form.body,
        categoryId: form.categoryId,
        summary: form.summary.trim() || undefined,
        coverMediaId: form.coverMediaId ?? undefined,
        status: form.status,
      });
      MessagePlugin.success('资讯已创建');
    }
    dialogVisible.value = false;
    await list.load();
  } catch (error) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  } finally {
    saving.value = false;
  }
}

async function changeStatus(row: unknown, status: ArticleDto['status']): Promise<void> {
  const item = row as ArticleDto;
  try {
    await setArticleStatus(item.id, status);
    MessagePlugin.success(status === 'published' ? '资讯已发布' : '资讯已下架');
    await list.load();
  } catch (error) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  }
}

function confirmDelete(row: unknown): void {
  const item = row as ArticleDto;
  const dialog = DialogPlugin.confirm({
    header: '删除资讯',
    body: `确定要删除「${item.title}」吗？`,
    theme: 'warning',
    confirmBtn: { content: '删除', theme: 'danger' },
    cancelBtn: '取消',
    onConfirm: async () => {
      try {
        await deleteArticle(item.id);
        MessagePlugin.success('资讯已删除');
        dialog.hide();
        await list.load();
      } catch (error) {
        // 错误提示由统一的 HTTP 客户端统一弹出
      }
    },
  });
}

function openCategoryManager(): void {
  editingCategoryId.value = null;
  categoryName.value = '';
  categorySlug.value = '';
  categorySort.value = 0;
  categoryVisible.value = true;
}

function editCategory(item: ArticleCategoryDto): void {
  editingCategoryId.value = item.id;
  categoryName.value = item.name;
  categorySlug.value = item.slug;
  categorySort.value = item.sortOrder;
}

function resetCategoryForm(): void {
  editingCategoryId.value = null;
  categoryName.value = '';
  categorySlug.value = '';
  categorySort.value = 0;
}

async function saveCategory(): Promise<void> {
  if (!categoryName.value.trim()) {
    MessagePlugin.warning('请填写分类名称');
    return;
  }
  categorySaving.value = true;
  try {
    if (editingCategoryId.value) {
      await updateCategory(editingCategoryId.value, {
        name: categoryName.value.trim(),
        slug: categorySlug.value.trim() || undefined,
        sortOrder: categorySort.value,
      });
      MessagePlugin.success('分类已更新');
    } else {
      await createCategory({
        name: categoryName.value.trim(),
        slug: categorySlug.value.trim(),
        sortOrder: categorySort.value,
      });
      MessagePlugin.success('分类已创建');
    }
    await loadCategories();
    await list.load();
  } catch (error) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  } finally {
    categorySaving.value = false;
  }
}

onMounted(() => {
  void loadCategories();
});
</script>

<template>
  <div class="page">
    <PageHeader title="资讯管理" description="发布与维护校友资讯，支持草稿、发布与下架">
      <template #actions>
        <t-button theme="primary" @click="openCreate">
          <template #icon><AppIcon name="plus" :size="16" /></template>
          新建资讯
        </t-button>
        <t-button theme="default" variant="outline" @click="openCategoryManager">分类管理</t-button>
        <t-button theme="default" variant="outline" :loading="list.loading.value" @click="list.load">
          <template #icon><AppIcon name="refresh" :size="16" /></template>
          刷新
        </t-button>
      </template>
    </PageHeader>

    <div class="filter-bar">
      <t-input
        v-model="filters.keyword"
        placeholder="搜索标题 / 摘要"
        clearable
        @input="onKeywordInput"
        @enter="list.search"
      />
      <t-select v-model="filters.status" :options="statusOptions" placeholder="状态" @change="list.search" />
      <t-select
        v-model="filters.categoryId"
        :options="categoryOptions"
        placeholder="分类"
        clearable
        @change="list.search"
      />
      <div class="inline">
        <t-button theme="primary" @click="list.search">查询</t-button>
      </div>
    </div>

    <div class="surface">
      <StateBox
        :loading="list.loading.value"
        :error="list.error.value"
        :empty="list.items.value.length === 0"
        empty-title="暂无资讯"
        empty-description="点击右上角「新建资讯」发布第一条内容。"
      >
        <template #retry>
          <t-button theme="default" variant="outline" @click="list.load">重新加载</t-button>
        </template>
        <t-table :data="list.items.value" :columns="columns" row-key="id" :loading="list.loading.value">
          <template #status="{ row }">
            <t-tag :theme="statusTheme(row)" variant="light" size="small">{{ statusText(row) }}</t-tag>
          </template>
          <template #publishedAt="{ row }">
            {{ formatDateTime(row.publishedAt) }}
          </template>
          <template #operation="{ row }">
            <div class="table-actions">
              <t-button theme="primary" variant="text" size="small" @click="openEdit(row)">编辑</t-button>
              <t-button
                v-if="row.status !== 'published'"
                theme="primary"
                variant="text"
                size="small"
                @click="changeStatus(row, 'published')"
              >
                发布
              </t-button>
              <t-button
                v-else
                theme="warning"
                variant="text"
                size="small"
                @click="changeStatus(row, 'offline')"
              >
                下架
              </t-button>
              <t-button theme="danger" variant="text" size="small" @click="confirmDelete(row)">删除</t-button>
            </div>
          </template>
        </t-table>
      </StateBox>
      <PagerBar
        :page="list.page.value"
        :page-size="list.pageSize.value"
        :total="list.meta.value.total"
        @update:page="list.changePage"
        @update:page-size="list.changePageSize"
      />
    </div>

    <t-dialog
      v-model:visible="dialogVisible"
      :header="editingId ? '编辑资讯' : '新建资讯'"
      :width="720"
      :confirm-btn="{ content: '保存', loading: saving }"
      cancel-btn="取消"
      @confirm="save"
    >
      <t-form layout="vertical">
        <t-form-item label="标题" :status="errors.title ? 'error' : undefined" :help="errors.title">
          <t-input v-model="form.title" placeholder="资讯标题" :maxlength="120" />
        </t-form-item>
        <div class="dialog-row">
          <t-form-item label="分类">
            <t-select
              v-model="form.categoryId"
              :options="categorySelectOptions"
              placeholder="选择分类"
              clearable
            />
          </t-form-item>
          <t-form-item label="状态">
            <t-select v-model="form.status" :options="articleStatusOptions" />
          </t-form-item>
        </div>
        <t-form-item label="摘要">
          <t-textarea
            v-model="form.summary"
            placeholder="列表展示的摘要"
            :autosize="{ minRows: 2, maxRows: 5 }"
          />
        </t-form-item>
        <t-form-item label="正文" :status="errors.body ? 'error' : undefined" :help="errors.body">
          <t-textarea v-model="form.body" placeholder="资讯正文" :autosize="{ minRows: 6, maxRows: 16 }" />
        </t-form-item>
        <t-form-item label="封面">
          <CoverUploader v-model="form.coverMediaId" :url="form.coverUrl" purpose="article-cover" />
        </t-form-item>
      </t-form>
    </t-dialog>

    <t-dialog v-model:visible="categoryVisible" header="分类管理" :width="620" :footer="false">
      <div class="stack">
        <t-table
          :data="categories"
          :columns="[
            { colKey: 'name', title: '名称', width: 140 },
            { colKey: 'slug', title: '标识', width: 140 },
            { colKey: 'sortOrder', title: '排序', width: 80 },
            { colKey: 'articleCount', title: '文章数', width: 90 },
            { colKey: 'operation', title: '操作', width: 80 },
          ]"
          row-key="id"
        >
          <template #operation="{ row }">
            <t-button theme="primary" variant="text" size="small" @click="editCategory(row)">编辑</t-button>
          </template>
        </t-table>

        <t-form label-align="left">
          <t-form-item label="分类名称">
            <t-input v-model="categoryName" placeholder="例如：校友动态" />
          </t-form-item>
          <t-form-item label="标识 slug">
            <t-input v-model="categorySlug" placeholder="例如：alumni" />
          </t-form-item>
          <t-form-item label="排序">
            <t-input-number v-model="categorySort" :min="0" style="width: 160px" />
          </t-form-item>
          <div class="inline">
            <t-button theme="primary" :loading="categorySaving" @click="saveCategory">
              {{ editingCategoryId ? '保存分类' : '新增分类' }}
            </t-button>
            <t-button
              v-if="editingCategoryId"
              theme="default"
              variant="outline"
              @click="resetCategoryForm"
            >
              取消编辑
            </t-button>
          </div>
        </t-form>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.dialog-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 16px;
}

@media (max-width: 720px) {
  .dialog-row {
    grid-template-columns: 1fr;
  }
}
</style>
