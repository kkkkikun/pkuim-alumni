<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { menuGroups } from '@/utils/menu';

const router = useRouter();
const auth = useAuthStore();

function goHome(): void {
  const first = menuGroups
    .flatMap((group) => group.items)
    .find((item) => auth.hasPermission(item.permission));
  router.push(first ? first.path : '/403');
}
</script>

<template>
  <div class="state-box" style="padding: 90px 20px">
    <div class="state-box__title">无访问权限</div>
    <p>当前账号缺少访问该页面所需的管理端权限点，请联系超级管理员调整角色。</p>
    <div class="inline" style="justify-content: center; margin-top: 16px">
      <t-button theme="primary" @click="goHome">返回可访问页面</t-button>
    </div>
  </div>
</template>
