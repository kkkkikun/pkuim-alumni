<script setup lang="ts">
import { reactive, ref } from 'vue';
import { MessagePlugin } from '@/plugins/tdesign';
import type { ResourcePostDto, ResourceStatus, ResourceType, ReviewAction } from '@nmg/contracts';
import {
  decideResource,
  fetchResourceAttachmentUrl,
  fetchResourceDetail,
  fetchResources,
  type AdminResourceQuery,
} from '@/api/admin';
import { errorMessage } from '@/api/http';
import { usePagedList } from '@/composables/usePagedList';
import { debounce } from '@/utils/debounce';
import {
  formatBytes,
  formatDateTime,
  RESOURCE_STATUS_LABELS,
  RESOURCE_STATUS_THEMES,
  RESOURCE_TYPE_LABELS,
  REVIEW_ACTION_LABELS,
} from '@/utils/format';
import PageHeader from '@/components/PageHeader.vue';
import StateBox from '@/components/StateBox.vue';
import PagerBar from '@/components/PagerBar.vue';
import AppIcon from '@/components/AppIcon.vue';

type StatusTab = ResourceStatus | 'all' | 'resource' | 'demand';

const activeTab = ref<StatusTab>('pending');
const filters = reactive({ keyword: '' });

function buildQuery(page: number, pageSize: number): AdminResourceQuery {
  const query: AdminResourceQuery = { page, pageSize };
  const keyword = filters.keyword.trim();
  if (keyword) query.keyword = keyword;
  if (activeTab.value === 'resource' || activeTab.value === 'demand') {
    query.type = activeTab.value as ResourceType;
  } else if (activeTab.value !== 'all') {
    query.status = activeTab.value as ResourceStatus;
  }
  return query;
}

const list = usePagedList<ResourcePostDto>((params) =>
  fetchResources(buildQuery(params.page, params.pageSize)),
);

const columns = [
  { colKey: 'title', title: '标题', width: 220 },
  { colKey: 'type', title: '类型', width: 80 },
  { colKey: 'authorName', title: '发布人', width: 100 },
  { colKey: 'industryName', title: '行业', width: 110 },
  { colKey: 'regionName', title: '地区', width: 110 },
  { colKey: 'status', title: '状态', width: 100 },
  { colKey: 'createdAt', title: '提交时间', width: 140 },
  { colKey: 'operation', title: '操作', width: 90 },
];

const tabs: Array<{ label: string; value: StatusTab }> = [
  { label: '待审核', value: 'pending' },
  { label: '资源', value: 'resource' },
  { label: '需求', value: 'demand' },
  { label: '已发布', value: 'published' },
  { label: '已拒绝', value: 'rejected' },
  { label: '已下架', value: 'offline' },
  { label: '全部', value: 'all' },
];

const drawerVisible = ref(false);
const detail = ref<ResourcePostDto | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);
const note = ref('');
const submitting = ref(false);

const debouncedSearch = debounce(() => {
  void list.search();
}, 400);

function onKeywordInput(): void {
  debouncedSearch();
}

function onTabChange(): void {
  void list.search();
}

function typeText(row: unknown): string {
  const item = row as ResourcePostDto;
  return RESOURCE_TYPE_LABELS[item.type] ?? item.type;
}

function statusText(row: unknown): string {
  const item = row as ResourcePostDto;
  return RESOURCE_STATUS_LABELS[item.status] ?? item.status;
}

function statusTheme(row: unknown): string {
  const item = row as ResourcePostDto;
  return RESOURCE_STATUS_THEMES[item.status] ?? 'default';
}

const previewLoading = ref<number | null>(null);

/**
 * 预览资源附件。
 *
 * 附件是**私有资产**（默认 visibility=private），`/uploads/{id}/url` 按归属鉴权，
 * 审核员取不到 → 404（KNOWN-ISSUES #77）。
 * 这里走「按业务对象鉴权」的管理端端点：附件确实挂在该待审内容上即可。
 */
async function previewAttachment(mediaId: number): Promise<void> {
  if (!detail.value) return;
  previewLoading.value = mediaId;
  try {
    const result = await fetchResourceAttachmentUrl(detail.value.id, mediaId);
    window.open(result.url, '_blank', 'noopener');
  } catch (error) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  } finally {
    previewLoading.value = null;
  }
}

async function openDetail(id: number): Promise<void> {
  drawerVisible.value = true;
  detailLoading.value = true;
  detailError.value = null;
  detail.value = null;
  note.value = '';
  try {
    detail.value = await fetchResourceDetail(id);
  } catch (error) {
    detailError.value = errorMessage(error);
  } finally {
    detailLoading.value = false;
  }
}

async function decide(action: ReviewAction): Promise<void> {
  if (!detail.value) return;
  submitting.value = true;
  try {
    await decideResource(detail.value.id, {
      action,
      note: note.value.trim() || undefined,
    });
    MessagePlugin.success(`已${REVIEW_ACTION_LABELS[action]}`);
    await openDetail(detail.value.id);
    await list.load();
  } catch (error) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="page">
    <PageHeader title="资源审核" description="审核校友发布的资源与需求内容，支持通过 / 退回修改 / 拒绝 / 下架">
      <template #actions>
        <t-button theme="default" variant="outline" :loading="list.loading.value" @click="list.load">
          <template #icon><AppIcon name="refresh" :size="16" /></template>
          刷新
        </t-button>
      </template>
    </PageHeader>

    <div class="surface">
      <div class="surface__head">
        <div class="status-tabs">
          <button
            v-for="tab in tabs"
            :key="tab.value"
            type="button"
            class="status-tabs__item"
            :class="{ 'status-tabs__item--active': activeTab === tab.value }"
            @click="activeTab = tab.value; onTabChange()"
          >
            {{ tab.label }}
          </button>
        </div>
        <t-input
          v-model="filters.keyword"
          placeholder="搜索标题 / 正文"
          clearable
          style="width: 240px"
          @input="onKeywordInput"
          @enter="list.search"
        />
      </div>

      <StateBox
        :loading="list.loading.value"
        :error="list.error.value"
        :empty="list.items.value.length === 0"
        empty-title="没有匹配的资源"
        empty-description="当前筛选条件下没有资源或需求记录。"
      >
        <template #retry>
          <t-button theme="default" variant="outline" @click="list.load">重新加载</t-button>
        </template>
        <t-table :data="list.items.value" :columns="columns" row-key="id" :loading="list.loading.value">
          <template #type="{ row }">
            <t-tag variant="outline" size="small">{{ typeText(row) }}</t-tag>
          </template>
          <template #status="{ row }">
            <t-tag :theme="statusTheme(row)" variant="light" size="small">{{ statusText(row) }}</t-tag>
          </template>
          <template #createdAt="{ row }">
            {{ formatDateTime(row.createdAt) }}
          </template>
          <template #operation="{ row }">
            <t-button theme="primary" variant="text" size="small" @click="openDetail(row.id)">审核</t-button>
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

    <t-drawer v-model:visible="drawerVisible" header="资源详情" :size="640" :footer="false">
      <StateBox :loading="detailLoading" :error="detailError">
        <template #retry>
          <t-button theme="default" variant="outline" @click="openDetail(detail?.id ?? 0)">
            重新加载
          </t-button>
        </template>

        <div v-if="detail" class="stack">
          <section>
            <h3 class="section-title">内容信息</h3>
            <div class="detail-grid">
              <div class="detail-grid__item">
                <span class="detail-grid__label">标题</span>
                <span class="detail-grid__value">{{ detail.title }}</span>
              </div>
              <div class="detail-grid__item">
                <span class="detail-grid__label">类型</span>
                <span class="detail-grid__value">{{ RESOURCE_TYPE_LABELS[detail.type] }}</span>
              </div>
              <div class="detail-grid__item">
                <span class="detail-grid__label">发布人</span>
                <span class="detail-grid__value">{{ detail.authorName }}</span>
              </div>
              <div class="detail-grid__item">
                <span class="detail-grid__label">行业</span>
                <span class="detail-grid__value">{{ detail.industryName || '—' }}</span>
              </div>
              <div class="detail-grid__item">
                <span class="detail-grid__label">地区</span>
                <span class="detail-grid__value">{{ detail.regionName || '—' }}</span>
              </div>
              <div class="detail-grid__item">
                <span class="detail-grid__label">当前版本</span>
                <span class="detail-grid__value">v{{ detail.version }}</span>
              </div>
              <div class="detail-grid__item">
                <span class="detail-grid__label">提交时间</span>
                <span class="detail-grid__value">{{ formatDateTime(detail.createdAt) }}</span>
              </div>
              <div class="detail-grid__item">
                <span class="detail-grid__label">发布时间</span>
                <span class="detail-grid__value">{{ formatDateTime(detail.publishedAt) }}</span>
              </div>
            </div>
            <p class="content-body">{{ detail.body }}</p>
          </section>

          <section>
            <h3 class="section-title">附件</h3>
            <div v-if="detail.attachments && detail.attachments.length" class="stack">
              <div v-for="item in detail.attachments" :key="item.id" class="inline attachment">
                <span>{{ item.fileName }}</span>
                <span class="muted">{{ formatBytes(item.size) }}</span>
                <t-button
                  theme="primary"
                  variant="text"
                  size="small"
                  :loading="previewLoading === item.mediaId"
                  @click="previewAttachment(item.mediaId)"
                >
                  预览
                </t-button>
              </div>
            </div>
            <t-empty v-else description="无附件" />
          </section>

          <section>
            <h3 class="section-title">审核意见</h3>
            <t-textarea
              v-model="note"
              placeholder="填写审核意见"
              :autosize="{ minRows: 3, maxRows: 8 }"
            />
            <div class="inline" style="margin-top: 12px">
              <t-button theme="success" :loading="submitting" @click="decide('approve')">通过</t-button>
              <t-button theme="warning" :loading="submitting" @click="decide('request_changes')">
                退回修改
              </t-button>
              <t-button theme="danger" variant="outline" :loading="submitting" @click="decide('reject')">
                拒绝
              </t-button>
              <t-button theme="default" variant="outline" :loading="submitting" @click="decide('offline')">
                下架
              </t-button>
            </div>
          </section>

          <section>
            <h3 class="section-title">审核历史</h3>
            <t-timeline v-if="detail.reviews && detail.reviews.length">
              <t-timeline-item v-for="review in detail.reviews" :key="review.id">
                <div class="inline">
                  <strong>{{ review.adminName }}</strong>
                  <t-tag variant="light" size="small">{{ REVIEW_ACTION_LABELS[review.action] }}</t-tag>
                  <span class="muted">{{ formatDateTime(review.createdAt) }}</span>
                  <span class="muted">v{{ review.snapshotVersion }}</span>
                </div>
                <p v-if="review.note" class="form-hint">{{ review.note }}</p>
              </t-timeline-item>
            </t-timeline>
            <t-empty v-else description="暂无审核历史" />
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

.content-body {
  margin: 14px 0 0;
  padding: 14px;
  background: var(--admin-surface-alt);
  border: 1px solid var(--admin-border);
  border-radius: var(--admin-radius-sm);
  line-height: 1.9;
  white-space: pre-wrap;
}

.attachment {
  padding: 10px 12px;
  border: 1px solid var(--admin-border);
  border-radius: var(--admin-radius-sm);
}

.status-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.status-tabs__item {
  border: 1px solid var(--admin-border);
  background: var(--white);
  color: var(--admin-text);
  border-radius: 16px;
  padding: 5px 14px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.status-tabs__item:hover {
  border-color: var(--admin-brand);
  color: var(--admin-brand);
}

.status-tabs__item--active {
  background: var(--admin-brand);
  border-color: var(--admin-brand);
  color: #fff;
}
</style>
