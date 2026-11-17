<script setup lang="ts">
import { ref } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { uploadMedia } from '@/api/system';
import AppIcon from './AppIcon.vue';

const props = withDefaults(
  defineProps<{
    modelValue?: number | null;
    url?: string | null;
    purpose?: string;
    label?: string;
  }>(),
  { modelValue: null, url: null, purpose: 'cover', label: '上传封面' },
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: number | null): void;
  (event: 'update:url', value: string | null): void;
}>();

const inputRef = ref<HTMLInputElement | null>(null);
const uploading = ref(false);

function trigger(): void {
  inputRef.value?.click();
}

async function onChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  uploading.value = true;
  try {
    const asset = await uploadMedia(file, { purpose: props.purpose });
    emit('update:modelValue', asset.id);
    emit('update:url', asset.url);
    MessagePlugin.success('文件上传成功');
  } catch (error) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  } finally {
    uploading.value = false;
    if (target) target.value = '';
  }
}
</script>

<template>
  <div class="uploader">
    <div v-if="props.url" class="uploader__preview">
      <img :src="props.url" alt="封面预览" />
    </div>
    <div class="uploader__actions">
      <t-button theme="default" variant="outline" :loading="uploading" @click="trigger">
        <template #icon><AppIcon name="upload" :size="16" /></template>
        {{ props.label }}
      </t-button>
      <span v-if="props.modelValue" class="muted">媒体 ID：{{ props.modelValue }}</span>
    </div>
    <input ref="inputRef" type="file" class="uploader__input" accept="image/*" @change="onChange" />
  </div>
</template>

<style scoped>
.uploader {
  display: flex;
  align-items: center;
  gap: 12px;
}

.uploader__preview img {
  width: 96px;
  height: 64px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--admin-border);
}

.uploader__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.uploader__input {
  display: none;
}
</style>
