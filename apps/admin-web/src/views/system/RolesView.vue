<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AdminPermission, AdminPermissionDto, AdminRole, AdminRoleDto } from '@nmg/contracts';
import { fetchPermissions, fetchRoles } from '@/api/admin';
import { errorMessage } from '@/api/http';
import { PERMISSION_LABELS, ROLE_LABELS, ROLE_PERMISSIONS } from '@/stores/auth';
import PageHeader from '@/components/PageHeader.vue';
import StateBox from '@/components/StateBox.vue';

// ⚠️ 第三轮：`GET /admin/roles` 与 `/admin/permissions` 改为分页结构，
//    且**条目是目录整行**（契约 `AdminRoleDto` / `AdminPermissionDto`），
//    不再是「代码字符串」。
//    此前的写法把返回的对象当代码字符串用（`ROLE_LABELS[role]` 恒为 undefined，
//    角色名渲染成 `[object Object]`）—— 契约写清楚之后一并纠正。
const roles = ref<AdminRoleDto[]>([]);
const permissions = ref<AdminPermissionDto[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const matrixColumns = computed(() => [
  { colKey: 'role', title: '角色', width: 160 },
  ...permissions.value.map((item) => ({ colKey: item.code, title: permissionLabel(item.code), width: 96 })),
]);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    // 目录表很小（角色 5 个 / 权限点 12 个），一次取完：
    // 用 pageSize=100（服务端上限）换回「整目录」语义，同时仍然有上限。
    const [rolePage, permissionPage] = await Promise.all([
      fetchRoles({ page: 1, pageSize: 100 }),
      fetchPermissions({ page: 1, pageSize: 100 }),
    ]);
    roles.value = rolePage.items;
    permissions.value = permissionPage.items;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

function roleLabel(role: AdminRole): string {
  return ROLE_LABELS[role] || role;
}

function permissionLabel(code: AdminPermission): string {
  return PERMISSION_LABELS[code] || code;
}

function hasPermission(role: AdminRole, code: AdminPermission): boolean {
  return (ROLE_PERMISSIONS[role] || []).includes(code);
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="page">
    <PageHeader
      title="角色权限"
      description="查看系统内置角色与权限点目录；权限校验始终由服务端执行"
    />

    <StateBox :loading="loading" :error="error">
      <template #retry>
        <t-button theme="default" variant="outline" @click="load">重新加载</t-button>
      </template>

      <div class="surface">
        <div class="surface__head">
          <div>
            <h2>角色目录</h2>
            <p>共 {{ roles.length }} 个角色</p>
          </div>
        </div>
        <div class="surface__body">
          <div class="role-grid">
            <div v-for="role in roles" :key="role.id" class="role-card">
              <strong>{{ roleLabel(role.code) }}</strong>
              <span class="mono muted">{{ role.code }}</span>
              <div class="role-card__tags">
                <t-tag
                  v-for="code in ROLE_PERMISSIONS[role.code] || []"
                  :key="code"
                  variant="light"
                  size="small"
                >
                  {{ permissionLabel(code) }}
                </t-tag>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="surface">
        <div class="surface__head">
          <div>
            <h2>权限点目录</h2>
            <p>共 {{ permissions.length }} 个权限点</p>
          </div>
        </div>
        <t-table
          :data="permissions"
          :columns="[
            { colKey: 'code', title: '权限编码', width: 200 },
            { colKey: 'name', title: '说明', width: 180 },
          ]"
          row-key="code"
        >
          <template #name="{ row }">
            {{ permissionLabel(row.code) }}
          </template>
        </t-table>
      </div>

      <div class="surface">
        <div class="surface__head">
          <div>
            <h2>角色 × 权限矩阵</h2>
            <p>依据系统初始化种子数据展示</p>
          </div>
        </div>
        <t-table :data="roles" :columns="matrixColumns" row-key="id">
          <template #role="{ row }">
            {{ roleLabel(row.code) }}
          </template>
          <template v-for="item in permissions" :key="item.code" #[item.code]="{ row }">
            <t-tag v-if="hasPermission(row.code, item.code)" theme="success" variant="light" size="small">
              ✓
            </t-tag>
            <span v-else class="muted">—</span>
          </template>
        </t-table>
      </div>
    </StateBox>
  </div>
</template>

<style scoped>
.role-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.role-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--admin-border);
  border-radius: var(--admin-radius);
  background: var(--admin-surface-alt);
}

.role-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
</style>
