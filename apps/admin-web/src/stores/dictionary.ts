import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { IndustryDto, RegionDto } from '@nmg/contracts';
import { fetchIndustries, fetchRegions } from '@/api/system';
import { errorMessage } from '@/api/http';

export interface DictionaryOption {
  label: string;
  value: string;
}

export const useDictionaryStore = defineStore('dictionary', () => {
  const regions = ref<RegionDto[]>([]);
  const industries = ref<IndustryDto[]>([]);
  const loading = ref(false);
  const loaded = ref(false);
  const error = ref<string | null>(null);

  const regionOptions = computed<DictionaryOption[]>(() =>
    regions.value.map((item) => ({ label: item.name, value: item.code })),
  );
  const industryOptions = computed<DictionaryOption[]>(() =>
    industries.value.map((item) => ({ label: item.name, value: item.code })),
  );

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return;
    loading.value = true;
    error.value = null;
    try {
      const [regionList, industryList] = await Promise.all([fetchRegions(), fetchIndustries()]);
      regions.value = regionList;
      industries.value = industryList;
      loaded.value = true;
    } catch (e) {
      error.value = errorMessage(e);
    } finally {
      loading.value = false;
    }
  }

  function regionName(code?: string | null): string {
    if (!code) return '—';
    return regions.value.find((item) => item.code === code)?.name ?? code;
  }

  function industryName(code?: string | null): string {
    if (!code) return '—';
    return industries.value.find((item) => item.code === code)?.name ?? code;
  }

  return {
    regions,
    industries,
    loading,
    loaded,
    error,
    regionOptions,
    industryOptions,
    load,
    regionName,
    industryName,
  };
});
