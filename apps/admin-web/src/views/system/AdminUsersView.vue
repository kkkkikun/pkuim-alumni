<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { MessagePlugin } from '@/plugins/tdesign';
import type { AdminRole, AdminRoleDto, AdminUserDto } from '@nmg/contracts';
import {
  createAdminUser,
  fetchAdminUsers,
  fetchRoles,
  updateAdminUser,
  type AdminUserQuery,
} from '@/api/admin';
import { usePagedList } from '@/composables/usePagedList';
import { debounce } from '@/utils/debounce';
import { formatDateTime, USER_STATUS_LABELS, USER_STATUS_THEMES } from '@/utils/format';
import { PERMISSION_LABELS, ROLE_LABELS, ROLE_PERMISSIONS } from '@/stores/auth';
import PageHeader from '@/components/PageHeader.vue';
import StateBox from '@/components/StateBox.vue';
import PagerBar from '@/components/PagerBar.vue';
import AppIcon from '@/components/AppIcon.vue';

const filters = reactive({
  keyword: '',
  status: '' as '' | AdminUserDto['status'],
});

function buildQuery(page: number, pageSize: number): AdminUserQuery {
  const query: AdminUserQuery = { page, pageSize };
  const keyword = filters.keyword.trim();
  if (keyword) query.keyword = keyword;
  if (filters.status) query.status = filters.status;
  return query;
}

const list = usePagedList<AdminUserDto>((params) =>
  fetchAdminUsers(buildQuery(params.page, params.pageSize)),
);

const columns = [
  { colKey: 'username', title: '账号', width: 120 },
  { colKey: 'displayName', title: '姓名', width: 120 },
  { colKey: 'roles', title: '角色', width: 220 },
  { colKey: 'status', title: '状态', width: 90 },
  { colKey: 'lastLoginAt', title: '最近登录', width: 140 },
  { colKey: 'operation', title: '操作', width: 90 },
];

const statusOptions = [
  { label: '全部状态', value: '' },
  { label: USER_STATUS_LABELS.active, value: 'active' },
  { label: USER_STATUS_LABELS.disabled, value: 'disabled' },
  // ⚠️ 管理员账号没有「已锁定」状态：admin_users.status 的 ENUM 只有
  // ('active','disabled')。此前这里给出「已锁定」筛选项，服务端又会接受它，
  // 结果是**永远筛不出任何行**的摆设筛选项（缺陷 #114）。
];

// ⚠️ 第三轮：`GET /admin/roles` 改为分页结构，条目是**目录整行**
//    （契约 `AdminRoleDto`），不再是「代码字符串」。
const roleCatalogue = ref<AdminRoleDto[]>([]);
const roleOptions = computed(() =>
  roleCatalogue.value.map((item) => ({ label: ROLE_LABELS[item.code] || item.code, value: item.code })),
);

const dialogVisible = ref(false);
const editingId = ref<number | null>(null);
const saving = ref(false);
const form = reactive({
  username: '',
  displayName: '',
  password: '',
  roles: [] as AdminRole[],
  status: 'active' as 'active' | 'disabled',
});
const errors = reactive<Record<string, string>>({});

const debouncedSearch = debounce(() => {
  void list.search();
}, 400);

function onKeywordInput(): void {
  debouncedSearch();
}

function statusText(row: unknown): string {
  const item = row as AdminUserDto;
  return USER_STATUS_LABELS[item.status] ?? item.status;
}

function statusTheme(row: unknown): string {
  const item = row as AdminUserDto;
  return USER_STATUS_THEMES[item.status] ?? 'default';
}

function roleNames(row: unknown): string {
  const item = row as AdminUserDto;
  return item.roles.map((role) => ROLE_LABELS[role] || role).join('、') || '—';
}

function resetForm(): void {
  form.username = '';
  form.displayName = '';
  form.password = '';
  form.roles = [];
  form.status = 'active';
  Object.keys(errors).forEach((key) => delete errors[key]);
}

function openCreate(): void {
  editingId.value = null;
  resetForm();
  dialogVisible.value = true;
}

function openEdit(row: unknown): void {
  const item = row as AdminUserDto;
  editingId.value = item.id;
  resetForm();
  form.username = item.username;
  form.displayName = item.displayName;
  form.roles = [...item.roles];
  form.status = item.status === 'disabled' ? 'disabled' : 'active';
  dialogVisible.value = true;
}

async function save(): Promise<void> {
  errors.displayName = form.displayName.trim() ? '' : '请填写管理员姓名';
  if (!editingId.value) {
    errors.username = form.username.trim() ? '' : '请填写登录账号';
    // 与服务端 DTO 对齐：初始口令必填，且至少 8 位
    errors.password = form.password.length >= 8 ? '' : '密码至少 8 位';
  } else {
    errors.username = '';
    errors.password = form.password && form.password.length < 8 ? '密码至少 8 位' : '';
  }
  if (errors.username || errors.displayName || errors.password) {
    MessagePlugin.warning('请先完善表单信息');
    return;
  }
  saving.value = true;
  try {
    if (editingId.value) {
      await updateAdminUser(editingId.value, {
        displayName: form.displayName.trim(),
        roles: form.roles,
        status: form.status,
        password: form.password || undefined,
      });
      MessagePlugin.success('管理员已更新');
    } else {
      await createAdminUser({
        username: form.username.trim(),
        displayName: form.displayName.trim(),
        password: form.password,
        roles: form.roles,
      });
      MessagePlugin.success('管理员已创建');
    }
    dialogVisible.value = false;
    await list.load();
  } catch (error) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  } finally {
    saving.value = false;
  }
}

async function loadRoles(): Promise<void> {
  try {
    // 角色目录表很小（5 个），一次取完；pageSize=100 是服务端上限。
    const page = await fetchRoles({ page: 1, pageSize: 100 });
    roleCatalogue.value = page.items;
  } catch (error) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  }
}

onMounted(() => {
  void loadRoles();
});
</script>

<template>
  <div class="page">
    <PageHeader title="管理员管理" description="维护后台管理员账号并分配管理角色">
      <template #actions>
        <t-button theme="primary" @click="openCreate">
          <template #icon><AppIcon name="plus" :size="16" /></template>
          新建管理员
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
        placeholder="搜索账号 / 姓名"
        clearable
        @input="onKeywordInput"
        @enter="list.search"
      />
      <t-select v-model="filters.status" :options="statusOptions" placeholder="账号状态" @change="list.search" />
      <div class="inline">
        <t-button theme="primary" @click="list.search">查询</t-button>
      </div>
    </div>

    <div class="surface">
      <StateBox
        :loading="list.loading.value"
        :error="list.error.value"
        :empty="list.items.value.length === 0"
        empty-title="暂无管理员"
        empty-description="点击右上角「新建管理员」创建后台账号。"
      >
        <template #retry>
          <t-button theme="default" variant="outline" @click="list.load">重新加载</t-button>
        </template>
        <t-table :data="list.items.value" :columns="columns" row-key="id" :loading="list.loading.value">
          <template #roles="{ row }">
            <span>{{ roleNames(row) }}</span>
          </template>
          <template #status="{ row }">
            <t-tag :theme="statusTheme(row)" variant="light" size="small">{{ statusText(row) }}</t-tag>
          </template>
          <template #lastLoginAt="{ row }">
            {{ formatDateTime(row.lastLoginAt) }}
          </template>
          <template #operation="{ row }">
            <t-button theme="primary" variant="text" size="small" @click="openEdit(row)">编辑</t-button>
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
      :header="editingId ? '编辑管理员' : '新建管理员'"
      :width="560"
      :confirm-btn="{ content: '保存', loading: saving }"
      cancel-btn="取消"
      @confirm="save"
    >
      <t-form layout="vertical">
        <t-form-item label="登录账号" :status="errors.username ? 'error' : undefined" :help="errors.username">
          <t-input v-model="form.username" placeholder="登录账号" :disabled="Boolean(editingId)" />
        </t-form-item>
        <t-form-item
          label="显示名称"
          :status="errors.displayName ? 'error' : undefined"
          :help="errors.displayName"
        >
          <t-input v-model="form.displayName" placeholder="例如：张三（超级管理员）" />
        </t-form-item>
        <t-form-item label="密码" :status="errors.password ? 'error' : undefined" :help="errors.password">
          <t-input
            v-model="form.password"
            type="password"
            :placeholder="editingId ? '留空表示不修改密码' : '至少 6 位'"
          />
        </t-form-item>
        <t-form-item label="角色">
          <t-select
            v-model="form.roles"
            :options="roleOptions"
            multiple
            filterable
            placeholder="可多选"
          />
          <p class="form-hint">
            角色对应的权限点：
            {{ form.roles.map((role) => (ROLE_PERMISSIONS[role] || []).map((code) => PERMISSION_LABELS[code]).join('、')).join('；') || '—' }}
          </p>
        </t-form-item>
        <t-form-item v-if="editingId" label="账号状态">
          <t-select
            v-model="form.status"
            :options="[
              { label: USER_STATUS_LABELS.active, value: 'active' },
              { label: USER_STATUS_LABELS.disabled, value: 'disabled' },
            ]"
          />
        </t-form-item>
      </t-form>
    </t-dialog>
  </div>
</template>
