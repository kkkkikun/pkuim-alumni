import { createApp } from 'vue';
import { createPinia } from 'pinia';
import '@/styles/tokens.css';
import '@/styles/global.css';
import App from '@/App.vue';
import router from '@/router';
import { useAuthStore } from '@/stores/auth';
import { onUnauthorized } from '@/api/session';
// ⚠️ TDesign **按需引入**（第三轮）：此前是 `app.use(TDesign)` 全量注册，
//    整个组件库（1.36 MB JS + 449 KB CSS）都进了首屏产物。
//    现在只注册真正用到的组件，见 `plugins/tdesign.ts`。
import { installTDesign } from '@/plugins/tdesign';

const app = createApp(App);

app.use(createPinia());
installTDesign(app);
app.use(router);

const auth = useAuthStore();

// 401 且刷新失败：统一清空会话并回到登录页
onUnauthorized(() => {
  auth.reset();
  if (!window.location.hash.startsWith('#/login')) {
    window.location.hash = '#/login';
  }
});

app.mount('#app');
