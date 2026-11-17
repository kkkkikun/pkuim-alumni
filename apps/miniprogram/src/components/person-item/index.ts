import type { DirectoryEntry } from '../../types';

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
