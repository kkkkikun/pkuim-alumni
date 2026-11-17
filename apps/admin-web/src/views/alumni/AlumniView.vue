<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import type { UserStatus } from '@nmg/contracts';
import {
  fetchAlumni,
  fetchAlumniDetail,
  updateUserStatus,
  type AdminAlumniDetail,
  type AdminAlumniListItem,
  type AdminAlumniQuery,
} from '@/api/admin';
import { errorMessage } from '@/api/http';
import { usePagedList } from '@/composables/usePagedList';
import { useDictionaryStore } from '@/stores/dictionary';
import { debounce } from '@/utils/debounce';
import { formatDateTime, USER_STATUS_LABELS, USER_STATUS_THEMES } from '@/utils/format';
import PageHeader from '@/components/PageHeader.vue';
import StateBox from '@/components/StateBox.vue';
import PagerBar from '@/components/PagerBar.vue';
import AppIcon from '@/components/AppIcon.vue';

const dictionary = useDictionaryStore();
void dictionary.load();

const filters = reactive({
  keyword: '',
  college: '',
  verified: '' as '' | 'true' | 'false',
  status: '' as '' | UserStatus,
  regionCode: '',
  industryCode: '',
  graduationYear: '' as '' | string,
});

function buildQuery(page: number, pageSize: number): AdminAlumniQuery {
  const query: AdminAlumniQuery = { page, pageSize };
  const keyword = filters.keyword.trim();
  if (keyword) query.keyword = keyword;
  if (filters.college.trim()) query.college = filters.college.trim();
  if (filters.verified) query.verified = filters.verified === 'true';
  if (filters.status) query.status = filters.status;
  if (filters.regionCode) query.regionCode = filters.regionCode;
  if (filters.industryCode) query.industryCode = filters.industryCode;
  if (filters.graduationYear) {
    const year = Number(filters.graduationYear);
    if (!Number.isNaN(year)) query.graduationYear = year;
  }
  return query;
}

const list = usePagedList<AdminAlumniListItem>((params) =>
  fetchAlumni(buildQuery(params.page, params.pageSize)),
);

const columns = [
  { colKey: 'displayName', title: '姓名', width: 110 },
  { colKey: 'college', title: '学院', width: 130 },
  { colKey: 'graduationYear', title: '毕业年份', width: 100 },
  { colKey: 'regionName', title: '地区', width: 110 },
  { colKey: 'industryName', title: '行业', width: 110 },
  { colKey: 'verified', title: '认证状态', width: 100 },
  { colKey: 'userStatus', title: '账号状态', width: 100 },
  { colKey: 'operation', title: '操作', width: 90 },
];

const verifiedOptions = [
  { label: '全部', value: '' },
  { label: '已认证', value: 'true' },
  { label: '未认证', value: 'false' },
];

const statusOptions = [
  { label: '全部', value: '' },
  { label: USER_STATUS_LABELS.active, value: 'active' },
  { label: USER_STATUS_LABELS.disabled, value: 'disabled' },
  { label: USER_STATUS_LABELS.locked, value: 'locked' },
];

const statusForm = reactive<{ status: UserStatus; reason: string }>({
  status: 'active',
  reason: '',
});

const drawerVisible = ref(false);
const detail = ref<AdminAlumniDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);
const statusSaving = ref(false);

const detailRows = computed(() => {
  const value = detail.value;
  if (!value) return [];
  return [
    { label: '用户 ID', text: String(value.userId) },
    { label: '姓名', text: value.displayName || '—' },
    { label: '真实姓名', text: value.realName || '—' },
    { label: '学院', text: value.college || '—' },
    { label: '学历', text: value.degree || '—' },
    { label: '毕业年份', text: value.graduationYear ? String(value.graduationYear) : '—' },
    { label: '地区', text: value.regionName || dictionary.regionName(value.regionCode) },
    { label: '行业', text: value.industryName || dictionary.industryName(value.industryCode) },
    { label: '研究/工作方向', text: value.direction || '—' },
    { label: '认证状态', text: value.verified ? '已认证' : '未认证' },
    { label: '认证时间', text: formatDateTime(value.verifiedAt) },
    { label: '账号状态', text: USER_STATUS_LABELS[value.userStatus] ?? value.userStatus },
    { label: '资料更新时间', text: formatDateTime(value.updatedAt) },
  ];
});

const debouncedSearch = debounce(() => {
  void list.search();
}, 400);

function onKeywordInput(): void {
  debouncedSearch();
}

function resetFilters(): void {
  filters.keyword = '';
  filters.college = '';
  filters.verified = '';
  filters.status = '';
  filters.regionCode = '';
  filters.industryCode = '';
  filters.graduationYear = '';
  void list.search();
}

async function openDetail(id: number): Promise<void> {
  drawerVisible.value = true;
  detailLoading.value = true;
  detailError.value = null;
  detail.value = null;
  try {
    const result = await fetchAlumniDetail(id);
    detail.value = result;
    statusForm.status = result.userStatus ?? 'active';
    statusForm.reason = '';
  } catch (error) {
    detailError.value = errorMessage(error);
  } finally {
    detailLoading.value = false;
  }
}

async function saveStatus(): Promise<void> {
  if (!detail.value) return;
  statusSaving.value = true;
  try {
    await updateUserStatus(detail.value.userId, {
      status: statusForm.status,
      reason: statusForm.reason.trim() || undefined,
    });
    MessagePlugin.success('账号状态已更新');
    await openDetail(detail.value.userId);
    await list.load();
  } catch (error) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  } finally {
    statusSaving.value = false;
  }
}

function verifiedText(row: unknown): string {
  const item = row as AdminAlumniListItem;
  return item.verified ? '已认证' : '未认证';
}

function statusText(row: unknown): string {
  const item = row as AdminAlumniListItem;
  return USER_STATUS_LABELS[item.userStatus] ?? item.userStatus;
}

function statusTheme(row: unknown): string {
  const item = row as AdminAlumniListItem;
  return USER_STATUS_THEMES[item.userStatus] ?? 'default';
}
</script>

<template>
  <div class="page">
    <PageHeader title="校友管理" description="检索校友档案、查看资料详情并管理账号状态">
      <template #actions>
        <t-button theme="default" variant="outline" :loading="list.loading.value" @click="list.load">
          <template #icon><AppIcon name="refresh" :size="16" /></template>
          刷新
        </t-button>
      </template>
    </PageHeader>

    <div class="filter-bar">
      <t-input
        v-model="filters.keyword"
        placeholder="搜索姓名 / 学院"
        clearable
        @input="onKeywordInput"
        @enter="list.search"
      />
      <t-input v-model="filters.college" placeholder="学院名称" clearable @enter="list.search" />
      <t-select v-model="filters.verified" :options="verifiedOptions" placeholder="认证状态" />
      <t-select v-model="filters.status" :options="statusOptions" placeholder="账号状态" />
      <t-select
        v-model="filters.regionCode"
        :options="dictionary.regionOptions"
        placeholder="所在地区"
        clearable
        filterable
      />
      <t-select
        v-model="filters.industryCode"
        :options="dictionary.industryOptions"
        placeholder="所在行业"
        clearable
        filterable
      />
      <t-input v-model="filters.graduationYear" placeholder="毕业年份" clearable @enter="list.search" />
      <div class="inline">
        <t-button theme="primary" @click="list.search">查询</t-button>
        <t-button theme="default" variant="outline" @click="resetFilters">重置</t-button>
      </div>
    </div>

    <div class="surface">
      <StateBox
        :loading="list.loading.value"
        :error="list.error.value"
        :empty="list.items.value.length === 0"
        empty-title="没有匹配的校友"
        empty-description="请调整筛选条件后重试。"
      >
        <template #retry>
          <t-button theme="default" variant="outline" @click="list.load">重新加载</t-button>
        </template>
        <t-table :data="list.items.value" :columns="columns" row-key="userId" :loading="list.loading.value">
          <template #verified="{ row }">
            <t-tag :theme="verifiedText(row) === '已认证' ? 'success' : 'default'" variant="light" size="small">
              {{ verifiedText(row) }}
            </t-tag>
          </template>
          <template #userStatus="{ row }">
            <t-tag :theme="statusTheme(row)" variant="light" size="small">{{ statusText(row) }}</t-tag>
          </template>
          <template #operation="{ row }">
            <t-button theme="primary" variant="text" size="small" @click="openDetail(row.userId)">
              详情
            </t-button>
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

    <t-drawer
      v-model:visible="drawerVisible"
      header="校友详情"
      :size="640"
      :footer="false"
    >
      <StateBox :loading="detailLoading" :error="detailError">
        <template #retry>
          <t-button theme="default" variant="outline" @click="openDetail(detail?.userId ?? 0)">
            重新加载
          </t-button>
        </template>

        <div v-if="detail" class="stack">
          <section>
            <h3 class="section-title">档案信息</h3>
            <div class="detail-grid">
              <div v-for="row in detailRows" :key="row.label" class="detail-grid__item">
                <span class="detail-grid__label">{{ row.label }}</span>
                <span class="detail-grid__value">{{ row.text }}</span>
              </div>
            </div>
            <p class="form-hint" style="margin-top: 10px">简介：{{ detail.intro || '—' }}</p>
          </section>

          <section>
            <h3 class="section-title">账号状态</h3>
            <div class="inline">
              <t-radio-group v-model="statusForm.status" variant="default-filled">
                <t-radio-button value="active">{{ USER_STATUS_LABELS.active }}</t-radio-button>
                <t-radio-button value="disabled">{{ USER_STATUS_LABELS.disabled }}</t-radio-button>
                <t-radio-button value="locked">{{ USER_STATUS_LABELS.locked }}</t-radio-button>
              </t-radio-group>
            </div>
            <t-input
              v-model="statusForm.reason"
              placeholder="变更原因（可选，将写入操作日志）"
              style="margin-top: 10px"
            />
            <div class="inline" style="margin-top: 12px">
              <t-button theme="primary" :loading="statusSaving" @click="saveStatus">保存账号状态</t-button>
            </div>
          </section>

          <section>
            <h3 class="section-title">身份审核历史</h3>
            <t-timeline v-if="detail.verifications && detail.verifications.length">
              <t-timeline-item v-for="item in detail.verifications" :key="item.id">
                <div class="inline">
                  <strong>{{ formatDateTime(item.submittedAt) }}</strong>
                  <t-tag variant="light" size="small">{{ item.status }}</t-tag>
                  <span class="muted">{{ item.college || '—' }} · {{ item.graduationYear || '—' }}</span>
                </div>
                <p v-if="item.decidedAt" class="form-hint">
                  审核于 {{ formatDateTime(item.decidedAt) }}
                </p>
              </t-timeline-item>
            </t-timeline>
            <t-empty v-else description="暂无身份审核记录" />
          </section>
        </div>
      </StateBox>
    </t-drawer>
  </div>
</template>

<style scoped>
.section-title {
  font-size: 15px;
  margin-bottom: 12px;
  padding-left: 10px;
  border-left: 3px solid var(--admin-brand);
}
</style>
