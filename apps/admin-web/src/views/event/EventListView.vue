<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { DialogPlugin, MessagePlugin } from '@/plugins/tdesign';
import type {
  EventDto,
  EventRegistrationDto,
  EventStatus,
  RegistrationStatus,
} from '@nmg/contracts';
import {
  deleteEvent,
  fetchEventRegistrations,
  fetchEvents,
  publishEvent,
  type AdminEventQuery,
} from '@/api/admin';
import { errorMessage } from '@/api/http';
import { usePagedList } from '@/composables/usePagedList';
import { debounce } from '@/utils/debounce';
import {
  EVENT_STATUS_LABELS,
  EVENT_STATUS_THEMES,
  formatDateTime,
  REGISTRATION_STATUS_LABELS,
} from '@/utils/format';
import PageHeader from '@/components/PageHeader.vue';
import StateBox from '@/components/StateBox.vue';
import PagerBar from '@/components/PagerBar.vue';
import AppIcon from '@/components/AppIcon.vue';

const router = useRouter();

const filters = reactive({
  keyword: '',
  status: '' as '' | EventStatus,
});

function buildQuery(page: number, pageSize: number): AdminEventQuery {
  const query: AdminEventQuery = { page, pageSize };
  const keyword = filters.keyword.trim();
  if (keyword) query.keyword = keyword;
  if (filters.status) query.status = filters.status;
  return query;
}

const list = usePagedList<EventDto>((params) => fetchEvents(buildQuery(params.page, params.pageSize)));

const columns = [
  { colKey: 'title', title: '活动名称', width: 200 },
  { colKey: 'kind', title: '类型', width: 100 },
  { colKey: 'regionName', title: '地区', width: 110 },
  { colKey: 'startsAt', title: '开始时间', width: 140 },
  { colKey: 'capacity', title: '人数/报名', width: 100 },
  { colKey: 'status', title: '状态', width: 90 },
  { colKey: 'operation', title: '操作', width: 210 },
];

const statusOptions = [
  { label: '全部状态', value: '' },
  { label: EVENT_STATUS_LABELS.draft, value: 'draft' },
  { label: EVENT_STATUS_LABELS.published, value: 'published' },
  { label: EVENT_STATUS_LABELS.closed, value: 'closed' },
  { label: EVENT_STATUS_LABELS.cancelled, value: 'cancelled' },
];

const rosterVisible = ref(false);
const rosterLoading = ref(false);
const rosterError = ref<string | null>(null);
const rosterTitle = ref('');
const roster = ref<EventRegistrationDto[]>([]);
/** 抽屉里当前打开的活动 id（翻页时要用它重新取数） */
const rosterEventId = ref(0);
const rosterPage = ref(1);
const rosterPageSize = ref(20);
const rosterTotal = ref(0);

const debouncedSearch = debounce(() => {
  void list.search();
}, 400);

function onKeywordInput(): void {
  debouncedSearch();
}

function statusText(row: unknown): string {
  const item = row as EventDto;
  return EVENT_STATUS_LABELS[item.status] ?? item.status;
}

function statusTheme(row: unknown): string {
  const item = row as EventDto;
  return EVENT_STATUS_THEMES[item.status] ?? 'default';
}

function capacityText(row: unknown): string {
  const item = row as EventDto;
  return `${item.registeredCount}/${item.capacity || '不限'}`;
}

/**
 * 报名名单（分页）。
 *
 * ⚠️ 第三轮：该端点从「裸数组（**全部**报名记录）」改为 `{items, meta}` ——
 *    一个 1000 人活动的点名此前是 1000 行全量返回。
 */
async function loadRoster(): Promise<void> {
  rosterLoading.value = true;
  rosterError.value = null;
  try {
    const result = await fetchEventRegistrations(rosterEventId.value, {
      page: rosterPage.value,
      pageSize: rosterPageSize.value,
    });
    roster.value = result.items;
    rosterTotal.value = result.meta.total;
  } catch (error) {
    rosterError.value = errorMessage(error);
  } finally {
    rosterLoading.value = false;
  }
}

async function openRoster(id: number, title: string): Promise<void> {
  rosterVisible.value = true;
  rosterTitle.value = title;
  rosterEventId.value = id;
  rosterPage.value = 1;
  roster.value = [];
  rosterTotal.value = 0;
  await loadRoster();
}

async function changeRosterPage(page: number): Promise<void> {
  rosterPage.value = page;
  await loadRoster();
}

async function changeRosterPageSize(pageSize: number): Promise<void> {
  rosterPageSize.value = pageSize;
  rosterPage.value = 1;
  await loadRoster();
}

async function togglePublish(row: unknown): Promise<void> {
  const item = row as EventDto;
  try {
    await publishEvent(item.id, item.status !== 'published');
    MessagePlugin.success(item.status === 'published' ? '活动已下线' : '活动已发布');
    await list.load();
  } catch (error) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  }
}

function confirmDelete(row: unknown): void {
  const item = row as EventDto;
  const dialog = DialogPlugin.confirm({
    header: '删除活动',
    body: `确定要删除活动「${item.title}」吗？该操作不可撤销。`,
    theme: 'warning',
    confirmBtn: { content: '删除', theme: 'danger' },
    cancelBtn: '取消',
    onConfirm: async () => {
      try {
        await deleteEvent(item.id);
        MessagePlugin.success('活动已删除');
        dialog.hide();
        await list.load();
      } catch (error) {
        // 错误提示由统一的 HTTP 客户端统一弹出
      }
    },
  });
}

/** 报名状态文案（表格插槽参数类型较宽，这里做一次安全收敛）。 */
function registrationLabel(status: string): string {
  return REGISTRATION_STATUS_LABELS[status as RegistrationStatus] ?? status;
}
</script>

<template>
  <div class="page">
    <PageHeader title="活动管理" description="创建、编辑、发布校友活动，并查看报名名单">
      <template #actions>
        <t-button theme="primary" @click="router.push('/events/new')">
          <template #icon><AppIcon name="plus" :size="16" /></template>
          新建活动
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
        placeholder="搜索活动名称"
        clearable
        @input="onKeywordInput"
        @enter="list.search"
      />
      <t-select v-model="filters.status" :options="statusOptions" placeholder="活动状态" @change="list.search" />
      <div class="inline">
        <t-button theme="primary" @click="list.search">查询</t-button>
      </div>
    </div>

    <div class="surface">
      <StateBox
        :loading="list.loading.value"
        :error="list.error.value"
        :empty="list.items.value.length === 0"
        empty-title="暂无活动"
        empty-description="点击右上角「新建活动」创建第一个校友活动。"
      >
        <template #retry>
          <t-button theme="default" variant="outline" @click="list.load">重新加载</t-button>
        </template>
        <t-table :data="list.items.value" :columns="columns" row-key="id" :loading="list.loading.value">
          <template #startsAt="{ row }">
            {{ formatDateTime(row.startsAt) }}
          </template>
          <template #capacity="{ row }">
            {{ capacityText(row) }}
          </template>
          <template #status="{ row }">
            <t-tag :theme="statusTheme(row)" variant="light" size="small">{{ statusText(row) }}</t-tag>
          </template>
          <template #operation="{ row }">
            <div class="table-actions">
              <t-button
                theme="primary"
                variant="text"
                size="small"
                @click="router.push(`/events/${row.id}/edit`)"
              >
                编辑
              </t-button>
              <t-button theme="primary" variant="text" size="small" @click="togglePublish(row)">
                {{ row.status === 'published' ? '下线' : '发布' }}
              </t-button>
              <t-button theme="primary" variant="text" size="small" @click="openRoster(row.id, row.title)">
                报名名单
              </t-button>
              <t-button theme="danger" variant="text" size="small" @click="confirmDelete(row)">
                删除
              </t-button>
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

    <t-drawer v-model:visible="rosterVisible" :header="`报名名单 · ${rosterTitle}`" :size="560" :footer="false">
      <StateBox
        :loading="rosterLoading"
        :error="rosterError"
        :empty="roster.length === 0"
        empty-title="暂无报名记录"
      >
        <template #retry>
          <t-button theme="default" variant="outline" @click="loadRoster">重新加载</t-button>
        </template>
        <t-table
          :data="roster"
          :columns="[
            { colKey: 'userName', title: '校友', width: 110 },
            { colKey: 'userId', title: '用户 ID', width: 90 },
            { colKey: 'status', title: '报名状态', width: 100 },
            { colKey: 'note', title: '备注' },
            { colKey: 'createdAt', title: '报名时间', width: 140 },
          ]"
          row-key="id"
        >
          <template #status="{ row }">
            <t-tag variant="light" size="small">
              {{ registrationLabel(row.status) }}
            </t-tag>
          </template>
          <template #createdAt="{ row }">
            {{ formatDateTime(row.createdAt) }}
          </template>
        </t-table>
      </StateBox>
      <PagerBar
        :page="rosterPage"
        :page-size="rosterPageSize"
        :total="rosterTotal"
        @update:page="changeRosterPage"
        @update:page-size="changeRosterPageSize"
      />
    </t-drawer>
  </div>
</template>
