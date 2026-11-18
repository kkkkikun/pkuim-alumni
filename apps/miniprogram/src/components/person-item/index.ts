import type { DirectoryEntry } from '../../types/index';

Component({
  properties: {
    entry: {
      type: Object,
      value: null as unknown as DirectoryEntry,
    },
  },
  methods: {
    onTap(): void {
      this.triggerEvent('tap', { entry: this.properties.entry });
    },
  },
});
