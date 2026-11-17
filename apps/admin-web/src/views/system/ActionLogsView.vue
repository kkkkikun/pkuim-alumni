<script setup lang="ts">
import { reactive } from 'vue';
import type { AdminActionLogDto } from '@nmg/contracts';
import { fetchActionLogs, type AdminActionLogQuery } from '@/api/admin';
import { usePagedList } from '@/composables/usePagedList';
import { formatDateTime } from '@/utils/format';
import PageHeader from '@/components/PageHeader.vue';
import StateBox from '@/components/StateBox.vue';
import PagerBar from '@/components/PagerBar.vue';
import AppIcon from '@/components/AppIcon.vue';

const filters = reactive({
  adminId: '' as '' | string,
  action: '',
  startDate: '' as '' | string,
  endDate: '' as '' | string,
});

function buildQuery(page: number, pageSize: number): AdminActionLogQuery {
  const query: AdminActionLogQuery = { page, pageSize };
  if (filters.adminId) {
    const adminId = Number(filters.adminId);
    if (!Number.isNaN(adminId)) query.adminId = adminId;
  }
  if (filters.action.trim()) query.action = filters.action.trim();
  if (filters.startDate) query.startDate = filters.startDate;
  if (filters.endDate) query.endDate = filters.endDate;
  return query;
}

const list = usePagedList<AdminActionLogDto>((params) =>
  fetchActionLogs(buildQuery(params.page, params.pageSize)),
);

const columns = [
  { colKey: 'createdAt', title: '时间', width: 150 },
  { colKey: 'adminName', title: '操作人', width: 110 },
  { colKey: 'action', title: '操作', width: 180 },
  { colKey: 'targetType', title: '对象类型', width: 110 },
  { colKey: 'targetId', title: '对象 ID', width: 100 },
  { colKey: 'ip', title: 'IP', width: 130 },
  { colKey: 'detail', title: '详情', width: 220 },
];

function detailText(row: unknown): string {
  const item = row as AdminActionLogDto;
  if (!item.detail) return '—';
  return JSON.stringify(item.detail);
}
</script>

<template>
  <div class="page">
    <PageHeader title="操作日志" description="记录管理端的关键操作，用于审计与问题追溯">
      <template #actions>
        <t-button theme="default" variant="outline" :loading="list.loading.value" @click="list.load">
          <template #icon><AppIcon name="refresh" :size="16" /></template>
          刷新
        </t-button>
      </template>
    </PageHeader>

    <div class="filter-bar">
      <t-input v-model="filters.adminId" placeholder="管理员 ID" clearable @enter="list.search" />
      <t-input v-model="filters.action" placeholder="操作标识，例如 verification.approve" clearable @enter="list.search" />
      <t-date-picker v-model="filters.startDate" placeholder="开始日期" clearable @change="list.search" />
      <t-date-picker v-model="filters.endDate" placeholder="结束日期" clearable @change="list.search" />
      <div class="inline">
        <t-button theme="primary" @click="list.search">查询</t-button>
      </div>
    </div>

    <div class="surface">
      <StateBox
        :loading="list.loading.value"
        :error="list.error.value"
        :empty="list.items.value.length === 0"
        empty-title="暂无操作日志"
        empty-description="当前筛选条件下没有日志记录。"
      >
        <template #retry>
          <t-button theme="default" variant="outline" @click="list.load">重新加载</t-button>
        </template>
        <t-table :data="list.items.value" :columns="columns" row-key="id" :loading="list.loading.value">
          <template #createdAt="{ row }">
            {{ formatDateTime(row.createdAt) }}
          </template>
          <template #targetType="{ row }">
            {{ row.targetType || '—' }}
          </template>
          <template #targetId="{ row }">
            {{ row.targetId || '—' }}
          </template>
          <template #ip="{ row }">
            {{ row.ip || '—' }}
          </template>
          <template #detail="{ row }">
            <span class="mono ellipsis">{{ detailText(row) }}</span>
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
