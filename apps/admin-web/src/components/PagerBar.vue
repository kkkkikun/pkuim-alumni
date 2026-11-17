<script setup lang="ts">
defineProps<{
  page: number;
  pageSize: number;
  total: number;
}>();

const emit = defineEmits<{
  (event: 'update:page', value: number): void;
  (event: 'update:pageSize', value: number): void;
}>();

function onCurrentChange(value: number): void {
  emit('update:page', value);
}

function onPageSizeChange(value: number): void {
  emit('update:pageSize', value);
}
</script>

<template>
  <div class="pager">
    <t-pagination
      :current="page"
      :page-size="pageSize"
      :total="total"
      :page-size-options="[10, 20, 50]"
      @current-change="onCurrentChange"
      @page-size-change="onPageSizeChange"
    />
  </div>
</template>
