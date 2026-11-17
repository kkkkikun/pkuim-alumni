import { bootstrap } from './bootstrap';

App({
  onLaunch(): void {
    void bootstrap();
  },
  globalData: {
    launchAt: Date.now(),
  },
});
