<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AdminStats } from '@nmg/contracts';
import { fetchStats } from '@/api/admin';
import { errorMessage } from '@/api/http';
import { useAuthStore } from '@/stores/auth';
import PageHeader from '@/components/PageHeader.vue';
import StateBox from '@/components/StateBox.vue';
import AppIcon from '@/components/AppIcon.vue';

const auth = useAuthStore();
const stats = ref<AdminStats | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const cards = computed(() => {
  if (!stats.value) return [];
  return [
    { key: 'alumniTotal', label: '校友总数', value: stats.value.alumniTotal, icon: 'users', permission: 'alumni:view' as const, path: '/alumni' },
    { key: 'alumniVerified', label: '已认证人数', value: stats.value.alumniVerified, icon: 'shield', permission: 'alumni:view' as const, path: '/alumni' },
    { key: 'verificationPending', label: '待审核人数', value: stats.value.verificationPending, icon: 'clock', permission: 'verification:review' as const, path: '/verification' },
    { key: 'resourceTotal', label: '资源发布数量', value: stats.value.resourceTotal, icon: 'inbox', permission: 'resource:review' as const, path: '/resource' },
    { key: 'resourcePending', label: '待审核资源', value: stats.value.resourcePending, icon: 'clock', permission: 'resource:review' as const, path: '/resource' },
    { key: 'eventTotal', label: '活动数量', value: stats.value.eventTotal, icon: 'calendar', permission: 'event:manage' as const, path: '/events' },
    { key: 'eventRegistrations', label: '活动报名总数', value: stats.value.eventRegistrations, icon: 'users', permission: 'event:manage' as const, path: '/events' },
    { key: 'connectionTotal', label: '连接总数', value: stats.value.connectionTotal, icon: 'key', permission: 'alumni:view' as const, path: '/alumni' },
    { key: 'connectionPending', label: '待处理连接申请', value: stats.value.connectionPending, icon: 'clock', permission: 'alumni:view' as const, path: '/alumni' },
    { key: 'userTotal', label: '注册用户总数', value: stats.value.userTotal, icon: 'users', permission: 'dashboard:view' as const, path: '/alumni' },
    { key: 'articleTotal', label: '资讯总数', value: stats.value.articleTotal, icon: 'article', permission: 'content:manage' as const, path: '/articles' },
    { key: 'noticeTotal', label: '公告总数', value: stats.value.noticeTotal, icon: 'bell', permission: 'content:manage' as const, path: '/notices' },
  ];
});

const visibleCards = computed(() => cards.value.filter((card) => auth.hasPermission(card.permission)));

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    stats.value = await fetchStats();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="page">
    <PageHeader title="数据总览" description="平台核心业务指标一览，数据来自服务端统计接口 /admin/stats">
      <template #actions>
        <t-button theme="default" variant="outline" :loading="loading" @click="load">
          <template #icon><AppIcon name="refresh" :size="16" /></template>
          刷新
        </t-button>
      </template>
    </PageHeader>

    <StateBox :loading="loading" :error="error">
      <template #retry>
        <t-button theme="default" variant="outline" @click="load">重新加载</t-button>
      </template>
      <div class="stat-grid">
        <div v-for="card in visibleCards" :key="card.key" class="stat-card">
          <div class="stat-card__icon"><AppIcon :name="card.icon" :size="20" /></div>
          <div class="stat-card__body">
            <p class="stat-card__label">{{ card.label }}</p>
            <p class="stat-card__value">{{ card.value }}</p>
          </div>
          <router-link class="stat-card__link" :to="card.path">查看</router-link>
        </div>
      </div>

      <div v-if="visibleCards.length === 0" class="surface__body muted">
        当前账号没有任何可查看的统计模块权限。
      </div>
    </StateBox>
  </div>
</template>

<style scoped>
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 14px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  background: var(--admin-surface);
  border: 1px solid var(--admin-border);
  border-radius: var(--admin-radius);
  box-shadow: var(--admin-shadow-soft);
}

.stat-card__icon {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  background: var(--admin-brand-soft);
  color: var(--admin-brand-deep);
  display: grid;
  place-items: center;
  flex: none;
}

.stat-card__body {
  flex: 1;
  min-width: 0;
}

.stat-card__label {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--admin-text-muted);
}

.stat-card__value {
  margin: 0;
  font-family: var(--serif);
  font-size: 24px;
  color: var(--admin-text-strong);
}

.stat-card__link {
  font-size: 12px;
  color: var(--admin-brand);
  white-space: nowrap;
}
</style>
