<script setup lang="ts">
import { reactive, ref } from 'vue';
import { MessagePlugin } from '@/plugins/tdesign';
import type { ReviewAction, VerificationApplicationDto, VerificationStatus } from '@nmg/contracts';
import {
  decideVerification,
  fetchVerificationAttachmentUrl,
  fetchVerificationDetail,
  fetchVerifications,
  type AdminVerificationQuery,
} from '@/api/admin';
import { errorMessage } from '@/api/http';
import { usePagedList } from '@/composables/usePagedList';
import { debounce } from '@/utils/debounce';
import {
  formatBytes,
  formatDateTime,
  REVIEW_ACTION_LABELS,
  VERIFICATION_STATUS_LABELS,
  VERIFICATION_STATUS_THEMES,
} from '@/utils/format';
import PageHeader from '@/components/PageHeader.vue';
import StateBox from '@/components/StateBox.vue';
import PagerBar from '@/components/PagerBar.vue';
import AppIcon from '@/components/AppIcon.vue';

const filters = reactive({
  keyword: '',
  status: 'pending' as VerificationStatus | '',
});

function buildQuery(page: number, pageSize: number): AdminVerificationQuery {
  const query: AdminVerificationQuery = { page, pageSize };
  const keyword = filters.keyword.trim();
  if (keyword) query.keyword = keyword;
  if (filters.status) query.status = filters.status;
  return query;
}

const list = usePagedList<VerificationApplicationDto>((params) =>
  fetchVerifications(buildQuery(params.page, params.pageSize)),
);

const columns = [
  { colKey: 'applicantName', title: '申请人', width: 110 },
  { colKey: 'college', title: '学院', width: 130 },
  { colKey: 'graduationYear', title: '毕业年份', width: 100 },
  { colKey: 'degree', title: '学历', width: 80 },
  { colKey: 'studentIdMasked', title: '学号', width: 130 },
  { colKey: 'status', title: '状态', width: 110 },
  { colKey: 'submittedAt', title: '提交时间', width: 140 },
  { colKey: 'operation', title: '操作', width: 90 },
];

const statusOptions = [
  { label: '待审核', value: 'pending' },
  { label: '待补充材料', value: 'needs_more_material' },
  { label: '已通过', value: 'approved' },
  { label: '已拒绝', value: 'rejected' },
  { label: '已重新提交', value: 'resubmitted' },
  { label: '全部状态', value: '' },
];

const drawerVisible = ref(false);
const detail = ref<VerificationApplicationDto | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);
const note = ref('');
const submitting = ref(false);
const previewLoading = ref<number | null>(null);

const debouncedSearch = debounce(() => {
  void list.search();
}, 400);

function onKeywordInput(): void {
  debouncedSearch();
}

function statusText(row: unknown): string {
  const item = row as VerificationApplicationDto;
  return VERIFICATION_STATUS_LABELS[item.status] ?? item.status;
}

function statusTheme(row: unknown): string {
  const item = row as VerificationApplicationDto;
  return VERIFICATION_STATUS_THEMES[item.status] ?? 'default';
}

async function openDetail(id: number): Promise<void> {
  drawerVisible.value = true;
  detailLoading.value = true;
  detailError.value = null;
  detail.value = null;
  note.value = '';
  try {
    detail.value = await fetchVerificationDetail(id);
  } catch (error) {
    detailError.value = errorMessage(error);
  } finally {
    detailLoading.value = false;
  }
}

/**
 * 预览证明材料。
 *
 * 注意：这里**不能**用 `/uploads/{id}/url` —— 那是资产归属语义（私有资产只有
 * 上传者本人可取），审核员取不到 → 404 → 审核流程走不通（KNOWN-ISSUES #77）。
 * 改走「按业务对象鉴权」的管理端端点：附件确实挂在该待审申请上即可。
 */
async function preview(mediaId: number): Promise<void> {
  if (!detail.value) return;
  previewLoading.value = mediaId;
  try {
    const result = await fetchVerificationAttachmentUrl(detail.value.id, mediaId);
    window.open(result.url, '_blank', 'noopener');
  } catch (error) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  } finally {
    previewLoading.value = null;
  }
}

async function decide(action: ReviewAction): Promise<void> {
  if (!detail.value) return;
  submitting.value = true;
  try {
    await decideVerification(detail.value.id, {
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
    <PageHeader title="身份审核" description="处理校友身份认证申请，查看证明材料与审核历史">
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
        placeholder="搜索申请人 / 学院"
        clearable
        @input="onKeywordInput"
        @enter="list.search"
      />
      <t-select v-model="filters.status" :options="statusOptions" placeholder="审核状态" @change="list.search" />
      <div class="inline">
        <t-button theme="primary" @click="list.search">查询</t-button>
      </div>
    </div>

    <div class="surface">
      <StateBox
        :loading="list.loading.value"
        :error="list.error.value"
        :empty="list.items.value.length === 0"
        empty-title="没有待处理的认证申请"
        empty-description="当前筛选条件下没有认证申请记录。"
      >
        <template #retry>
          <t-button theme="default" variant="outline" @click="list.load">重新加载</t-button>
        </template>
        <t-table :data="list.items.value" :columns="columns" row-key="id" :loading="list.loading.value">
          <template #status="{ row }">
            <t-tag :theme="statusTheme(row)" variant="light" size="small">{{ statusText(row) }}</t-tag>
          </template>
          <template #submittedAt="{ row }">
            {{ formatDateTime(row.submittedAt) }}
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

    <t-drawer v-model:visible="drawerVisible" header="认证申请详情" :size="640" :footer="false">
      <StateBox :loading="detailLoading" :error="detailError">
        <template #retry>
          <t-button theme="default" variant="outline" @click="openDetail(detail?.id ?? 0)">
            重新加载
          </t-button>
        </template>

        <div v-if="detail" class="stack">
          <section>
            <h3 class="section-title">申请信息</h3>
            <div class="detail-grid">
              <div class="detail-grid__item">
                <span class="detail-grid__label">申请人</span>
                <span class="detail-grid__value">{{ detail.applicantName }}</span>
              </div>
              <div class="detail-grid__item">
                <span class="detail-grid__label">学院</span>
                <span class="detail-grid__value">{{ detail.college || '—' }}</span>
              </div>
              <div class="detail-grid__item">
                <span class="detail-grid__label">毕业年份</span>
                <span class="detail-grid__value">{{ detail.graduationYear || '—' }}</span>
              </div>
              <div class="detail-grid__item">
                <span class="detail-grid__label">学历</span>
                <span class="detail-grid__value">{{ detail.degree || '—' }}</span>
              </div>
              <div class="detail-grid__item">
                <span class="detail-grid__label">学号</span>
                <span class="detail-grid__value">{{ detail.studentIdMasked || '—' }}</span>
              </div>
              <div class="detail-grid__item">
                <span class="detail-grid__label">提交时间</span>
                <span class="detail-grid__value">{{ formatDateTime(detail.submittedAt) }}</span>
              </div>
              <div class="detail-grid__item">
                <span class="detail-grid__label">当前状态</span>
                <span class="detail-grid__value">
                  <t-tag variant="light" size="small">
                    {{ VERIFICATION_STATUS_LABELS[detail.status] ?? detail.status }}
                  </t-tag>
                </span>
              </div>
              <div class="detail-grid__item">
                <span class="detail-grid__label">决定时间</span>
                <span class="detail-grid__value">{{ formatDateTime(detail.decidedAt) }}</span>
              </div>
            </div>
          </section>

          <section>
            <h3 class="section-title">证明材料</h3>
            <div v-if="detail.attachments && detail.attachments.length" class="stack">
              <div
                v-for="attachment in detail.attachments"
                :key="attachment.id"
                class="inline attachment"
              >
                <t-tag variant="outline" size="small">{{ attachment.mimeType }}</t-tag>
                <span>{{ attachment.fileName }}</span>
                <span class="muted">{{ formatBytes(attachment.size) }}</span>
                <t-button
                  theme="primary"
                  variant="text"
                  size="small"
                  :loading="previewLoading === attachment.mediaId"
                  @click="preview(attachment.mediaId)"
                >
                  预览
                </t-button>
              </div>
            </div>
            <t-empty v-else description="未上传证明材料" />
          </section>

          <section>
            <h3 class="section-title">审核意见</h3>
            <t-textarea
              v-model="note"
              placeholder="填写审核意见（“要求补充”建议说明需要补充的材料）"
              :autosize="{ minRows: 3, maxRows: 8 }"
            />
            <div class="inline" style="margin-top: 12px">
              <t-button theme="success" :loading="submitting" @click="decide('approve')">通过</t-button>
              <t-button theme="warning" :loading="submitting" @click="decide('request_changes')">
                要求补充
              </t-button>
              <t-button theme="danger" variant="outline" :loading="submitting" @click="decide('reject')">
                拒绝
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

.attachment {
  padding: 10px 12px;
  border: 1px solid var(--admin-border);
  border-radius: var(--admin-radius-sm);
  background: var(--admin-surface-alt);
}
</style>
