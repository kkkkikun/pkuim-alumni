<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { MessagePlugin } from '@/plugins/tdesign';
import { useAuthStore, ROLE_LABELS } from '@/stores/auth';
import { menuGroups } from '@/utils/menu';
import { mockEnabled } from '@/api/mock';
import AppIcon from '@/components/AppIcon.vue';

const route = useRoute();
const auth = useAuthStore();

const visibleGroups = computed(() =>
  menuGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => auth.hasPermission(item.permission)),
    }))
    .filter((group) => group.items.length > 0),
);

const pageTitle = computed(() => route.meta.title || '校友会管理后台');

const roleTags = computed(() =>
  auth.roles.map((role) => ({ code: role, label: ROLE_LABELS[role] || role })),
);

async function handleLogout(): Promise<void> {
  await auth.logout();
  MessagePlugin.info('已退出登录');
  window.location.hash = '#/login';
}

/** 子路由（如 /events/1/edit）同样高亮所属菜单 */
function isActive(path: string): boolean {
  return route.path === path || route.path.startsWith(`${path}/`);
}
</script>

<template>
  <div class="layout">
    <aside class="layout__aside">
      <div class="brand">
        <span class="brand__stamp">北大</span>
        <div class="brand__text">
          <strong>校友会管理后台</strong>
          <small>内蒙古北京大学校友会</small>
        </div>
      </div>

      <nav class="nav">
        <div v-for="group in visibleGroups" :key="group.key" class="nav__group">
          <p class="nav__group-title">{{ group.title }}</p>
          <router-link
            v-for="item in group.items"
            :key="item.key"
            :to="item.path"
            class="nav__item"
            :class="{ 'nav__item--active': isActive(item.path) }"
          >
            <AppIcon :name="item.icon" :size="17" />
            <span>{{ item.title }}</span>
          </router-link>
        </div>
      </nav>

      <p class="nav__footer">V1 · 内蒙古北京大学校友会数字化平台</p>
    </aside>

    <div class="layout__main">
      <header class="topbar">
        <div class="topbar__title">
          <h1>{{ pageTitle }}</h1>
        </div>
        <div class="topbar__right">
          <span v-if="mockEnabled" class="topbar__mock">演示数据模式</span>
          <div class="topbar__admin">
            <div class="topbar__admin-text">
              <strong>{{ auth.displayName }}</strong>
              <div class="topbar__roles">
                <t-tag
                  v-for="role in roleTags"
                  :key="role.code"
                  theme="primary"
                  variant="light"
                  size="small"
                >
                  {{ role.label }}
                </t-tag>
              </div>
            </div>
          </div>
          <t-button theme="default" variant="outline" size="small" @click="handleLogout">
            退出登录
          </t-button>
        </div>
      </header>

      <main class="layout__content">
        <div v-if="mockEnabled" class="demo-banner">
          当前为演示数据模式（VITE_USE_MOCK=true），所有数据来自前端 mock 适配层，未连接真实 API。
        </div>
        <router-view />
      </main>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 232px 1fr;
  min-height: 100vh;
  background: var(--admin-bg);
}

.layout__aside {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 20px 14px;
  background: linear-gradient(180deg, #a51e28 0%, #8e1621 100%);
  color: #fdf3f0;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 6px;
}

.brand__stamp {
  width: 40px;
  height: 40px;
  flex: none;
  border: 1.5px solid rgba(255, 255, 255, 0.85);
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-family: var(--serif);
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 1px;
}

.brand__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.brand__text strong {
  font-family: var(--serif);
  font-size: 16px;
  letter-spacing: 1px;
}

.brand__text small {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.72);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
}

.nav__group-title {
  margin: 0 0 6px 8px;
  font-size: 11px;
  letter-spacing: 1.5px;
  color: rgba(255, 255, 255, 0.55);
}

.nav__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 10px;
  color: rgba(255, 255, 255, 0.86);
  font-size: 14px;
  transition: background 0.18s ease, color 0.18s ease;
}

.nav__item:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}

.nav__item--active {
  background: rgba(255, 255, 255, 0.94);
  color: var(--admin-brand-deep);
  font-weight: 600;
}

.nav__footer {
  margin: 0;
  padding: 12px 8px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.18);
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
}

.layout__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 26px;
  background: var(--white);
  border-bottom: 1px solid var(--admin-border);
  position: sticky;
  top: 0;
  z-index: 10;
}

.topbar__title h1 {
  font-size: 19px;
  letter-spacing: 1px;
}

.topbar__right {
  display: flex;
  align-items: center;
  gap: 14px;
}

.topbar__mock {
  background: #fff4e8;
  border: 1px solid #e8b981;
  color: #8a5a1f;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 6px;
}

.topbar__admin-text {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.topbar__admin-text strong {
  font-size: 14px;
  color: var(--admin-text-strong);
}

.topbar__roles {
  display: flex;
  gap: 4px;
}

.layout__content {
  padding: 20px 26px 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
  }

  .layout__aside {
    position: static;
    height: auto;
  }
}
</style>
