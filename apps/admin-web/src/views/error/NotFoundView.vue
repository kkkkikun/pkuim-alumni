<script setup lang="ts">
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <div class="state-box" style="padding: 90px 20px">
    <div class="state-box__title">页面不存在</div>
    <p>请检查地址是否正确，或返回数据总览。</p>
    <div class="inline" style="justify-content: center; margin-top: 16px">
      <t-button theme="primary" @click="router.push('/')">返回首页</t-button>
    </div>
  </div>
</template>
