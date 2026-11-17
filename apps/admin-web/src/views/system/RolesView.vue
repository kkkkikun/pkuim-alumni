<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AdminPermission, AdminRole } from '@nmg/contracts';
import { fetchPermissions, fetchRoles } from '@/api/admin';
import { errorMessage } from '@/api/http';
import { PERMISSION_LABELS, ROLE_LABELS, ROLE_PERMISSIONS } from '@/stores/auth';
import PageHeader from '@/components/PageHeader.vue';
import StateBox from '@/components/StateBox.vue';

const roles = ref<AdminRole[]>([]);
const permissions = ref<AdminPermission[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const matrixColumns = computed(() => [
  { colKey: 'role', title: '角色', width: 160 },
  ...permissions.value.map((code) => ({ colKey: code, title: permissionLabel(code), width: 96 })),
]);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [roleList, permissionList] = await Promise.all([fetchRoles(), fetchPermissions()]);
    roles.value = roleList;
    permissions.value = permissionList;
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
            <div v-for="role in roles" :key="role" class="role-card">
              <strong>{{ roleLabel(role) }}</strong>
              <span class="mono muted">{{ role }}</span>
              <div class="role-card__tags">
                <t-tag
                  v-for="code in ROLE_PERMISSIONS[role] || []"
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
        <t-table :data="roles" :columns="matrixColumns" row-key="role">
          <template #role="{ row }">
            {{ roleLabel(row) }}
          </template>
          <template v-for="code in permissions" :key="code" #[code]="{ row }">
            <t-tag v-if="hasPermission(row, code)" theme="success" variant="light" size="small">
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
