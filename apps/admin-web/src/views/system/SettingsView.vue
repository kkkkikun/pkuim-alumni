<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import type { SystemSettingDto } from '@nmg/contracts';
import { fetchSettings, upsertSetting } from '@/api/admin';
import { errorMessage } from '@/api/http';
import { formatDateTime } from '@/utils/format';
import PageHeader from '@/components/PageHeader.vue';
import StateBox from '@/components/StateBox.vue';
import AppIcon from '@/components/AppIcon.vue';

const settings = ref<SystemSettingDto[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const savingKey = ref<string | null>(null);

const draft = reactive<Record<string, string>>({});
const creating = ref(false);
const newSetting = reactive({ key: '', value: '', description: '' });

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    settings.value = await fetchSettings();
    settings.value.forEach((item) => {
      draft[item.key] = item.value;
    });
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

async function save(item: SystemSettingDto): Promise<void> {
  const value = draft[item.key] ?? item.value;
  savingKey.value = item.key;
  try {
    await upsertSetting({
      key: item.key,
      value,
      description: item.description ?? undefined,
    });
    MessagePlugin.success(`「${item.key}」已保存`);
    await load();
  } catch (e) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  } finally {
    savingKey.value = null;
  }
}

async function create(): Promise<void> {
  if (!newSetting.key.trim()) {
    MessagePlugin.warning('请填写配置项 key');
    return;
  }
  savingKey.value = newSetting.key.trim();
  try {
    await upsertSetting({
      key: newSetting.key.trim(),
      value: newSetting.value,
      description: newSetting.description.trim() || undefined,
    });
    MessagePlugin.success('配置项已保存');
    creating.value = false;
    newSetting.key = '';
    newSetting.value = '';
    newSetting.description = '';
    await load();
  } catch (e) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  } finally {
    savingKey.value = null;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="page">
    <PageHeader title="系统设置" description="维护平台运行参数，保存后立即写入服务端配置表">
      <template #actions>
        <t-button theme="primary" @click="creating = true">
          <template #icon><AppIcon name="plus" :size="16" /></template>
          新增配置
        </t-button>
        <t-button theme="default" variant="outline" :loading="loading" @click="load">
          <template #icon><AppIcon name="refresh" :size="16" /></template>
          刷新
        </t-button>
      </template>
    </PageHeader>

    <StateBox
      :loading="loading"
      :error="error"
      :empty="settings.length === 0"
      empty-title="暂无配置项"
      empty-description="点击右上角「新增配置」添加第一个配置项。"
    >
      <template #retry>
        <t-button theme="default" variant="outline" @click="load">重新加载</t-button>
      </template>

      <div class="surface">
        <t-table
          :data="settings"
          :columns="[
            { colKey: 'key', title: '配置项', width: 200 },
            { colKey: 'value', title: '值', width: 260 },
            { colKey: 'description', title: '说明', width: 200 },
            { colKey: 'updatedAt', title: '更新时间', width: 150 },
            { colKey: 'operation', title: '操作', width: 90 },
          ]"
          row-key="key"
        >
          <template #value="{ row }">
            <t-input v-model="draft[row.key]" />
          </template>
          <template #description="{ row }">
            {{ row.description || '—' }}
          </template>
          <template #updatedAt="{ row }">
            {{ formatDateTime(row.updatedAt) }}
          </template>
          <template #operation="{ row }">
            <t-button
              theme="primary"
              variant="text"
              size="small"
              :loading="savingKey === row.key"
              @click="save(row)"
            >
              保存
            </t-button>
          </template>
        </t-table>
      </div>
    </StateBox>

    <t-dialog
      v-model:visible="creating"
      header="新增配置项"
      :width="520"
      :confirm-btn="{ content: '保存', loading: savingKey !== null }"
      cancel-btn="取消"
      @confirm="create"
    >
      <t-form layout="vertical">
        <t-form-item label="配置项 key">
          <t-input v-model="newSetting.key" placeholder="例如 site.name" />
        </t-form-item>
        <t-form-item label="值">
          <t-input v-model="newSetting.value" placeholder="配置值" />
        </t-form-item>
        <t-form-item label="说明">
          <t-input v-model="newSetting.description" placeholder="配置项说明（可选）" />
        </t-form-item>
      </t-form>
    </t-dialog>
  </div>
</template>
