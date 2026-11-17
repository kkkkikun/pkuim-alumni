<script setup lang="ts">
withDefaults(
  defineProps<{
    loading?: boolean;
    error?: string | null;
    empty?: boolean;
    emptyTitle?: string;
    emptyDescription?: string;
  }>(),
  {
    loading: false,
    error: null,
    empty: false,
    emptyTitle: '暂无数据',
    emptyDescription: '当前筛选条件下没有记录。',
  },
);
</script>

<template>
  <div v-if="loading" class="state-box">
    <div class="state-box__title">加载中…</div>
    <p>正在向服务端请求数据，请稍候。</p>
  </div>
  <div v-else-if="error" class="state-box">
    <div class="state-box__title text-danger">加载失败</div>
    <p>{{ error }}</p>
    <div class="inline" style="justify-content: center; margin-top: 12px">
      <slot name="retry" />
    </div>
  </div>
  <div v-else-if="empty" class="state-box">
    <div class="state-box__title">{{ emptyTitle }}</div>
    <p>{{ emptyDescription }}</p>
  </div>
  <slot v-else />
</template>
