<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { MessagePlugin } from '@/plugins/tdesign';
import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/api/http';
import { mockEnabled } from '@/api/mock';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const form = reactive({
  username: '',
  password: '',
});

const errors = reactive<{ username?: string; password?: string }>({});
const submitting = ref(false);
const submitError = ref<string | null>(null);

const redirectTarget = computed(() => {
  const redirect = route.query.redirect;
  return typeof redirect === 'string' && redirect.startsWith('/') ? redirect : '/';
});

function validate(): boolean {
  errors.username = form.username.trim() ? '' : '请输入管理员账号';
  errors.password = form.password ? '' : '请输入登录密码';
  return !errors.username && !errors.password;
}

async function handleSubmit(): Promise<void> {
  submitError.value = null;
  if (!validate()) return;
  submitting.value = true;
  try {
    await auth.login(form.username.trim(), form.password);
    MessagePlugin.success('登录成功');
    await router.push(redirectTarget.value);
  } catch (error) {
    submitError.value = errorMessage(error);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login">
    <section class="login__intro">
      <div class="login__stamp">北大</div>
      <h1>
        内蒙古<br />
        <span>北京大学校友会</span><br />
        数字化管理平台
      </h1>
      <p class="login__lead">
        校友资料、身份审核、资源与活动、内容发布与系统权限，
        全部通过统一 REST API 管理真实业务数据。
      </p>
      <ul class="login__points">
        <li>校友档案与身份审核</li>
        <li>资源 / 需求内容审核</li>
        <li>活动发布与报名管理</li>
        <li>资讯公告与角色权限</li>
      </ul>
    </section>

    <section class="login__panel">
      <div class="login__card">
        <h2>管理员登录</h2>
        <p class="login__hint">请使用管理后台账号登录。</p>

        <div v-if="mockEnabled" class="demo-banner">
          演示数据模式：任意账号密码均可登录，数据不会写入服务端。
        </div>

        <t-form layout="vertical" @submit="handleSubmit">
          <t-form-item label="账号" :status="errors.username ? 'error' : undefined" :help="errors.username">
            <t-input
              v-model="form.username"
              placeholder="请输入管理员账号"
              autocomplete="username"
              :disabled="submitting"
              @enter="handleSubmit"
            />
          </t-form-item>
          <t-form-item label="密码" :status="errors.password ? 'error' : undefined" :help="errors.password">
            <t-input
              v-model="form.password"
              type="password"
              placeholder="请输入登录密码"
              autocomplete="current-password"
              :disabled="submitting"
              @enter="handleSubmit"
            />
          </t-form-item>

          <t-alert v-if="submitError" theme="error" :message="submitError" style="margin-bottom: 14px" />

          <t-button theme="primary" block :loading="submitting" @click="handleSubmit">登录</t-button>
        </t-form>
      </div>
    </section>
  </div>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 1.1fr 1fr;
  background: var(--admin-bg);
}

.login__intro {
  padding: 64px 58px;
  background: linear-gradient(155deg, #b52832 0%, #a51e28 45%, #8e1621 100%);
  color: #fff;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 26px;
}

.login__stamp {
  width: 58px;
  height: 58px;
  border: 2px solid rgba(255, 255, 255, 0.9);
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-family: var(--serif);
  font-weight: 700;
  font-size: 20px;
  letter-spacing: 1px;
}

.login__intro h1 {
  color: #fff;
  font-size: 40px;
  line-height: 1.5;
  letter-spacing: 3px;
}

.login__intro h1 span {
  color: #f7d9c9;
}

.login__lead {
  margin: 0;
  max-width: 430px;
  font-size: 14px;
  line-height: 2;
  color: rgba(255, 255, 255, 0.82);
}

.login__points {
  margin: 0;
  padding-left: 18px;
  color: rgba(255, 255, 255, 0.75);
  font-size: 13px;
  line-height: 2.1;
}

.login__panel {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 30px;
}

.login__card {
  width: 100%;
  max-width: 400px;
  background: var(--white);
  border: 1px solid var(--admin-border);
  border-radius: 18px;
  box-shadow: var(--admin-shadow);
  padding: 32px 30px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.login__card h2 {
  font-size: 22px;
  letter-spacing: 1px;
}

.login__hint {
  margin: -8px 0 0;
  font-size: 13px;
  color: var(--admin-text-muted);
}

@media (max-width: 900px) {
  .login {
    grid-template-columns: 1fr;
  }

  .login__intro {
    padding: 40px 28px;
  }

  .login__intro h1 {
    font-size: 30px;
  }
}
</style>
