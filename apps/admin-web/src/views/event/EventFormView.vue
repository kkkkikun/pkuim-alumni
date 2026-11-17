<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { MessagePlugin } from 'tdesign-vue-next';
import type { CreateEventBody, EventDto } from '@nmg/contracts';
import { createEvent, fetchEventDetail, updateEvent } from '@/api/admin';
import { errorMessage } from '@/api/http';
import { useDictionaryStore } from '@/stores/dictionary';
import { EVENT_KIND_OPTIONS, toIso, toPickerValue } from '@/utils/format';
import PageHeader from '@/components/PageHeader.vue';
import StateBox from '@/components/StateBox.vue';
import CoverUploader from '@/components/CoverUploader.vue';

const route = useRoute();
const router = useRouter();
const dictionary = useDictionaryStore();
void dictionary.load();

const eventId = computed(() => {
  const raw = route.params.id;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
});
const isEdit = computed(() => eventId.value !== null);

const form = reactive({
  title: '',
  kind: EVENT_KIND_OPTIONS[0].value as string,
  regionCode: '',
  place: '',
  description: '',
  startsAt: '',
  endsAt: '',
  capacity: 50,
  status: 'draft' as 'draft' | 'published',
  coverMediaId: null as number | null,
  coverUrl: null as string | null,
});

const errors = reactive<Record<string, string>>({});
const loading = ref(false);
const loadError = ref<string | null>(null);
const submitting = ref(false);

const statusOptions = [
  { label: '草稿（不展示在小程序）', value: 'draft' },
  { label: '立即发布', value: 'published' },
];

function validate(): boolean {
  errors.title = form.title.trim() ? '' : '请填写活动名称';
  errors.kind = form.kind ? '' : '请选择活动类型';
  errors.startsAt = form.startsAt ? '' : '请选择活动开始时间';
  errors.endsAt = form.endsAt ? '' : '请选择活动结束时间';
  if (form.startsAt && form.endsAt) {
    errors.endsAt =
      new Date(form.endsAt).getTime() > new Date(form.startsAt).getTime()
        ? ''
        : '结束时间必须晚于开始时间';
  }
  const capacity = Number(form.capacity);
  errors.capacity =
    Number.isInteger(capacity) && capacity >= 0 ? '' : '人数上限需为不小于 0 的整数（0 表示不限）';
  return !Object.values(errors).some((value) => value);
}

async function loadDetail(): Promise<void> {
  if (!eventId.value) return;
  loading.value = true;
  loadError.value = null;
  try {
    const detail: EventDto = await fetchEventDetail(eventId.value);
    form.title = detail.title;
    form.kind = detail.kind;
    form.regionCode = detail.regionCode ?? '';
    form.place = detail.place ?? '';
    form.description = detail.description ?? '';
    form.startsAt = toPickerValue(detail.startsAt);
    form.endsAt = toPickerValue(detail.endsAt);
    form.capacity = detail.capacity;
    form.status = detail.status === 'published' ? 'published' : 'draft';
    form.coverMediaId = detail.coverMediaId;
  } catch (error) {
    loadError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}

async function submit(): Promise<void> {
  if (!validate()) {
    MessagePlugin.warning('请先完善表单信息');
    return;
  }
  submitting.value = true;
  const body: CreateEventBody = {
    title: form.title.trim(),
    kind: form.kind,
    regionCode: form.regionCode || undefined,
    place: form.place.trim() || undefined,
    description: form.description.trim() || undefined,
    startsAt: toIso(form.startsAt),
    endsAt: toIso(form.endsAt),
    capacity: Number(form.capacity),
    coverMediaId: form.coverMediaId ?? undefined,
    status: form.status,
  };
  try {
    if (eventId.value) {
      await updateEvent(eventId.value, body);
      MessagePlugin.success('活动已更新');
    } else {
      await createEvent(body);
      MessagePlugin.success('活动已创建');
    }
    await router.push('/events');
  } catch (error) {
    // 错误提示由统一的 HTTP 客户端统一弹出
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  void loadDetail();
});
</script>

<template>
  <div class="page">
    <PageHeader
      :title="isEdit ? '编辑活动' : '新建活动'"
      description="填写活动信息后保存；草稿状态不会在小程序端展示"
    >
      <template #actions>
        <t-button theme="default" variant="outline" @click="router.push('/events')">返回列表</t-button>
      </template>
    </PageHeader>

    <StateBox :loading="loading" :error="loadError">
      <template #retry>
        <t-button theme="default" variant="outline" @click="loadDetail">重新加载</t-button>
      </template>

      <div class="surface">
        <div class="surface__body">
          <t-form layout="vertical" class="event-form">
            <div class="event-form__row">
              <t-form-item label="活动名称" :status="errors.title ? 'error' : undefined" :help="errors.title">
                <t-input v-model="form.title" placeholder="例如：2026 年呼和浩特校友新春聚会" :maxlength="100" />
              </t-form-item>
              <t-form-item label="活动类型" :status="errors.kind ? 'error' : undefined" :help="errors.kind">
                <t-select v-model="form.kind" :options="EVENT_KIND_OPTIONS" placeholder="请选择活动类型" />
              </t-form-item>
            </div>

            <div class="event-form__row">
              <t-form-item label="所属地区">
                <t-select
                  v-model="form.regionCode"
                  :options="dictionary.regionOptions"
                  placeholder="请选择地区"
                  clearable
                  filterable
                />
              </t-form-item>
              <t-form-item label="活动地点">
                <t-input v-model="form.place" placeholder="例如：呼和浩特市新城区某酒店" />
              </t-form-item>
            </div>

            <div class="event-form__row">
              <t-form-item
                label="开始时间"
                :status="errors.startsAt ? 'error' : undefined"
                :help="errors.startsAt"
              >
                <t-date-picker v-model="form.startsAt" enable-time-picker placeholder="选择开始时间" />
              </t-form-item>
              <t-form-item label="结束时间" :status="errors.endsAt ? 'error' : undefined" :help="errors.endsAt">
                <t-date-picker v-model="form.endsAt" enable-time-picker placeholder="选择结束时间" />
              </t-form-item>
            </div>

            <div class="event-form__row">
              <t-form-item
                label="人数上限"
                :status="errors.capacity ? 'error' : undefined"
                :help="errors.capacity"
              >
                <t-input-number v-model="form.capacity" :min="0" :max="100000" style="width: 100%" />
              </t-form-item>
              <t-form-item label="发布状态">
                <t-select v-model="form.status" :options="statusOptions" />
              </t-form-item>
            </div>

            <t-form-item label="活动说明">
              <t-textarea
                v-model="form.description"
                placeholder="介绍活动流程、参与方式等"
                :autosize="{ minRows: 4, maxRows: 12 }"
              />
            </t-form-item>

            <t-form-item label="活动封面">
              <CoverUploader
                v-model="form.coverMediaId"
                :url="form.coverUrl"
                purpose="event-cover"
                label="上传封面"
              />
              <p class="form-hint">封面图片通过 POST /uploads 上传，保存后写入 coverMediaId。</p>
            </t-form-item>

            <div class="inline">
              <t-button theme="primary" :loading="submitting" @click="submit">
                {{ isEdit ? '保存修改' : '创建活动' }}
              </t-button>
              <t-button theme="default" variant="outline" @click="router.push('/events')">取消</t-button>
            </div>
          </t-form>
        </div>
      </div>
    </StateBox>
  </div>
</template>

<style scoped>
.event-form__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 18px;
}

@media (max-width: 760px) {
  .event-form__row {
    grid-template-columns: 1fr;
  }
}
</style>
