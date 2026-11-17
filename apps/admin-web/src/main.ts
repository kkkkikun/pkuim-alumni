import { createApp } from 'vue';
import { createPinia } from 'pinia';
import TDesign from 'tdesign-vue-next';
import 'tdesign-vue-next/es/style/index.css';
import '@/styles/tokens.css';
import '@/styles/global.css';
import App from '@/App.vue';
import router from '@/router';
import { useAuthStore } from '@/stores/auth';
import { onUnauthorized } from '@/api/session';

const app = createApp(App);

app.use(createPinia());
app.use(TDesign);
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
