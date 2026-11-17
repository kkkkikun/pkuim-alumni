import type { EventDto } from '../../types';

Component({
  properties: {
    event: {
      type: Object,
      value: null as unknown as EventDto,
    },
  },
  methods: {
    onTap(): void {
      this.triggerEvent('tap', { event: this.properties.event });
    },
  },
});
