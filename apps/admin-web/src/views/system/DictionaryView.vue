<script setup lang="ts">
import { onMounted } from 'vue';
import { useDictionaryStore } from '@/stores/dictionary';
import PageHeader from '@/components/PageHeader.vue';
import StateBox from '@/components/StateBox.vue';

const dictionary = useDictionaryStore();

onMounted(() => {
  void dictionary.load(true);
});
</script>

<template>
  <div class="page">
    <PageHeader
      title="字典管理"
      description="查看平台地区字典与行业字典，数据来自 /system/regions 与 /system/industries"
    />

    <StateBox
      :loading="dictionary.loading"
      :error="dictionary.error"
      :empty="dictionary.regions.length === 0 && dictionary.industries.length === 0"
      empty-title="暂无字典数据"
      empty-description="服务端尚未初始化地区与行业字典。"
    >
      <template #retry>
        <t-button theme="default" variant="outline" @click="dictionary.load(true)">重新加载</t-button>
      </template>

      <div class="surface">
        <div class="surface__head">
          <div>
            <h2>地区字典</h2>
            <p>共 {{ dictionary.regions.length }} 条</p>
          </div>
        </div>
        <t-table
          :data="dictionary.regions"
          :columns="[
            { colKey: 'code', title: '编码', width: 140 },
            { colKey: 'name', title: '名称', width: 180 },
            { colKey: 'level', title: '范围', width: 110 },
            { colKey: 'sortOrder', title: '排序', width: 90 },
            { colKey: 'alumniCount', title: '校友人数', width: 110 },
          ]"
          row-key="code"
        >
          <template #level="{ row }">
            <t-tag variant="light" size="small">{{ row.level === 'city' ? '市内' : '市外' }}</t-tag>
          </template>
        </t-table>
      </div>

      <div class="surface">
        <div class="surface__head">
          <div>
            <h2>行业字典</h2>
            <p>共 {{ dictionary.industries.length }} 条</p>
          </div>
        </div>
        <t-table
          :data="dictionary.industries"
          :columns="[
            { colKey: 'code', title: '编码', width: 140 },
            { colKey: 'name', title: '名称', width: 180 },
            { colKey: 'sortOrder', title: '排序', width: 90 },
            { colKey: 'alumniCount', title: '校友人数', width: 110 },
          ]"
          row-key="code"
        />
      </div>
    </StateBox>
  </div>
</template>
