import type { EventView } from '../../utils/view';

Component({
  properties: {
    event: {
      type: Object,
      value: null as unknown as EventView,
    },
  },
  methods: {
    onTap(): void {
      this.triggerEvent('tap', { event: this.properties.event });
    },
  },
});
