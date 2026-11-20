<script setup lang="ts">
import { reactive, ref } from 'vue';
import { DialogPlugin, MessagePlugin } from '@/plugins/tdesign';
import type { NoticeDto } from '@nmg/contracts';
import {
  createNotice,
  deleteNotice,
  fetchNotices,
  setNoticeStatus,
  updateNotice,
  type AdminNoticeQuery,
} from '@/api/admin';
import { usePagedList } from '@/composables/usePagedList';
import { debounce } from '@/utils/debounce';
import { CONTENT_STATUS_LABELS, CONTENT_STATUS_THEMES, formatDateTime } from '@/utils/format';
import PageHeader from '@/components/PageHeader.vue';
import StateBox from '@/components/StateBox.vue';
import PagerBar from '@/components/PagerBar.vue';
import AppIcon from '@/components/AppIcon.vue';

const filters = reactive({
  keyword: '',
  status: '' as '' | NoticeDto['status'],
});

function buildQuery(page: number, pageSize: number): AdminNoticeQuery {
  const query: AdminNoticeQuery = { page, pageSize };
  const keyword = filters.keyword.trim();
  if (keyword) query.keyword = keyword;
  if (filters.status) query.status = filters.status;
  return query;
}

const list = usePagedList<NoticeDto>((params) => fetchNotices(buildQuery(params.page, params.pageSize)));

const columns = [
  { colKey: 'title', title: '标题', width: 240 },
  { colKey: 'body', title: '内容', width: 260 },
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

const noticeStatusOptions = [
  { label: '草稿', value: 'draft' },
  { label: '已发布', value: 'published' },
];

const dialogVisible = ref(false);
const editingId = ref<number | null>(null);
const saving = ref(false);
const form = reactive({
  title: '',
  body: '',
  status: 'draft' as 'draft' | 'published',
});
const errors = reactive<Record<string, string>>({});

const debouncedSearch = debounce(() => {
  void list.search();
}, 400);

function onKeywordInput(): void {
  debouncedSearch();
}

function statusText(row: unknown): string {
  const item = row as NoticeDto;
  return CONTENT_STATUS_LABELS[item.status] ?? item.status;
}

function statusTheme(row: unknown): string {
  const item = row as NoticeDto;
  return CONTENT_STATUS_THEMES[item.status] ?? 'default';
}

function openCreate(): void {
  editingId.value = null;
  form.title = '';
  form.body = '';
  form.status = 'draft';
  Object.keys(errors).forEach((key) => delete errors[key]);
  dialogVisible.value = true;
}

function openEdit(row: unknown): void {
  const item = row as NoticeDto;
  editingId.value = item.id;
  form.title = item.title;
  form.body = item.body;
  form.status = item.status === 'published' ? 'published' : 'draft';
  Object.keys(errors).forEach((key) => delete errors[key]);
  dialogVisible.value = true;
}

async function save(): Promise<void> {
  errors.title = form.title.trim() ? '' : '请填写公告标题';
  errors.body = form.body.trim() ? '' : '请填写公告内容';
  if (errors.title || errors.body) {
    MessagePlugin.warning('请先完善表单信息');
    return;
  }
  saving.value = true;
  try {
    if (editingId.value) {
      await updateNotice(editingId.value, {
        title: form.title.trim(),
        body: form.body,
        status: form.status,
      });
      MessagePlugin.success('公告已更新');
    } else {
      await createNotice({
        title: form.title.trim(),
        body: form.body,
        status: form.status,
      });
      MessagePlugin.success('公告已创建');
    }
    dialogVisible.value = false;
    await list.load();
  } catch (error) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  } finally {
    saving.value = false;
  }
}

async function changeStatus(row: unknown, status: NoticeDto['status']): Promise<void> {
  const item = row as NoticeDto;
  try {
    await setNoticeStatus(item.id, status);
    MessagePlugin.success(status === 'published' ? '公告已发布' : '公告已下架');
    await list.load();
  } catch (error) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  }
}

function confirmDelete(row: unknown): void {
  const item = row as NoticeDto;
  const dialog = DialogPlugin.confirm({
    header: '删除公告',
    body: `确定要删除「${item.title}」吗？`,
    theme: 'warning',
    confirmBtn: { content: '删除', theme: 'danger' },
    cancelBtn: '取消',
    onConfirm: async () => {
      try {
        await deleteNotice(item.id);
        MessagePlugin.success('公告已删除');
        dialog.hide();
        await list.load();
      } catch (error) {
        // 错误提示由统一的 HTTP 客户端统一弹出
      }
    },
  });
}
</script>

<template>
  <div class="page">
    <PageHeader title="公告管理" description="发布平台公告与通知，支持草稿、发布与下架">
      <template #actions>
        <t-button theme="primary" @click="openCreate">
          <template #icon><AppIcon name="plus" :size="16" /></template>
          新建公告
        </t-button>
        <t-button theme="default" variant="outline" :loading="list.loading.value" @click="list.load">
          <template #icon><AppIcon name="refresh" :size="16" /></template>
          刷新
        </t-button>
      </template>
    </PageHeader>

    <div class="filter-bar">
      <t-input
        v-model="filters.keyword"
        placeholder="搜索公告标题 / 内容"
        clearable
        @input="onKeywordInput"
        @enter="list.search"
      />
      <t-select v-model="filters.status" :options="statusOptions" placeholder="状态" @change="list.search" />
      <div class="inline">
        <t-button theme="primary" @click="list.search">查询</t-button>
      </div>
    </div>

    <div class="surface">
      <StateBox
        :loading="list.loading.value"
        :error="list.error.value"
        :empty="list.items.value.length === 0"
        empty-title="暂无公告"
        empty-description="点击右上角「新建公告」发布公告。"
      >
        <template #retry>
          <t-button theme="default" variant="outline" @click="list.load">重新加载</t-button>
        </template>
        <t-table :data="list.items.value" :columns="columns" row-key="id" :loading="list.loading.value">
          <template #body="{ row }">
            <span class="ellipsis">{{ row.body }}</span>
          </template>
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
      :header="editingId ? '编辑公告' : '新建公告'"
      :width="640"
      :confirm-btn="{ content: '保存', loading: saving }"
      cancel-btn="取消"
      @confirm="save"
    >
      <t-form layout="vertical">
        <t-form-item label="标题" :status="errors.title ? 'error' : undefined" :help="errors.title">
          <t-input v-model="form.title" placeholder="公告标题" :maxlength="120" />
        </t-form-item>
        <t-form-item label="内容" :status="errors.body ? 'error' : undefined" :help="errors.body">
          <t-textarea v-model="form.body" placeholder="公告内容" :autosize="{ minRows: 6, maxRows: 16 }" />
        </t-form-item>
        <t-form-item label="状态">
          <t-select v-model="form.status" :options="noticeStatusOptions" />
        </t-form-item>
      </t-form>
    </t-dialog>
  </div>
</template>

<style scoped>
.ellipsis {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
