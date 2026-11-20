import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:3000';

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      host: '0.0.0.0',
      port: Number(env.VITE_DEV_PORT || 5174),
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 500,
      rollupOptions: {
        output: {
          // ⚠️ 第三轮：TDesign 改为**按需引入**（见 `src/plugins/tdesign.ts`）——
          //    只注册模板里真正用到的 19 个组件，每个组件从**深路径**引入，
          //    打包器因此能把没用到的组件整个摇掉。
          //
          //    ⚠️ 但**仍要把它单独切成一个 chunk**（用函数式 `manualChunks` 按
          //    「路径含 tdesign-vue-next」归堆，而不是按包名归堆）：
          //    TDesign 内部有**循环依赖**（`es/_chunks/dep-*.mjs` 之间互相引用），
          //    一旦被并进主 chunk，Rollup 的求值顺序会变，
          //    运行时报 `Cannot access 'r$' before initialization`（TDZ）——
          //    页面直接白屏。单独成 chunk 时求值顺序与官方分发一致。
          manualChunks(id: string) {
            // ⚠️ **所有 node_modules 归到同一个 chunk**（不按包再切）。
            //
            //    为什么不按包切（vendor / tdesign 分开）：
            //    TDesign 的包内**循环依赖**跨过了包边界 ——
            //    它的 `es/_chunks/dep-*.mjs` 互相引用，且与 `vue` / `dayjs` /
            //    `lodash-es` 交叉引用。一旦按包切成两个 chunk，
            //    两个 chunk 之间就形成 **ESM 循环依赖**，
            //    浏览器求值到一半会撞上 TDZ：
            //    `ReferenceError: Cannot access 'xx' before initialization`
            //    —— **页面直接白屏**（首屏连登录框都渲染不出来）。
            //    把 node_modules 收进**一个** chunk，chunk 之间就没有环了。
            //
            //    首屏下载量不受影响：这些依赖本来就要在首屏下载
            //    （`index.html` 里全部是 `modulepreload`），
            //    本轮真正降下来的量来自「按需引入」少引的那些 TDesign 组件。
            if (id.includes('node_modules')) return 'vendor';
            return undefined;
          },
        },
      },
    },
  };
});
