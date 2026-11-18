/**
 * 运行时配置。
 *
 * ⚠️ 部署前必改：
 *  1. `API_BASE_URL` —— 改成私网 API 的真实地址（含 `/api/v1` 前缀）。
 *     未改动时默认指向本机 3000 端口，便于开发者工具直连本机 API。
 *  2. `USE_MOCK_LOGIN` —— 小程序注册完成、微信 AppID/AppSecret 配置到后端后，
 *     改为 `false` 即可切换到 `wx.login` 真实登录，业务代码无需改动。
 *
 * 💡 发布时**不要手改本文件**：上传脚本会用
 *    `--api-base-url` / `--mock-login` / `--data-mode` 在**构建期注入**这三个值，
 *    上传完自动还原源码（`trap` 保证异常路径也还原），
 *    并且会在**产物里**核对注入是否真的生效（见 miniprogram-compile-check.mjs）。
 *    本文件的默认值只影响「开发者工具里直接跑」的本地开发态。
 *
 * 说明：真实 AppID 写在 `project.config.json` 的 `appid` 字段
 *     （当前为 wx6761deb1125d858f），不要写进本文件。
 */

/** API 根地址，必须以 `/api/v1` 结尾 */
export const API_BASE_URL = 'http://127.0.0.1:3000/api/v1';

/** 统一接口前缀，与 contracts `API_PREFIX` 保持一致 */
export const API_PREFIX = '/api/v1';

/** 是否使用 Mock 登录（开发阶段为 true） */
export const USE_MOCK_LOGIN = true;

/** Mock 登录使用的开发用 openid（仅开发环境有意义） */
export const MOCK_OPENID = 'dev_mock_openid_nmg_001';

/** Mock 登录显示昵称 */
export const MOCK_NICKNAME = '演示校友';

/** 单次请求超时（毫秒） */
export const REQUEST_TIMEOUT = 15000;

/** 分页默认每页条数 */
export const DEFAULT_PAGE_SIZE = 10;

/** 本地存储键 */
export const STORAGE_KEYS = {
  token: 'nmg_alumni_token',
  scroll: 'nmg_alumni_scroll',
  user: 'nmg_alumni_user',
} as const;

/** 开发者工具调试开关：仅用于在页面上显示接口地址，不影响业务 */
export const SHOW_DEBUG_BAR = false;

/* ------------------------------ 数据模式 ------------------------------ */

/**
 * 数据模式开关（离线演示兜底层）。
 *
 * - `live`  ：只走真实 API。行为与接入兜底之前完全一致（网络失败即报错）。
 * - `demo`  ：**完全不发起 `wx.request`**，所有接口由 `src/demo/router.ts`
 *             用本地演示数据应答。用于「后端还没上公网」的演示场合。
 * - `auto`  ：优先真实 API；**仅当发生网络层失败**（`wx.request` 的 fail 回调，
 *             即 `ApiError.code === 'NETWORK_ERROR'`）时回退到演示数据。
 *
 * ⚠️ `auto` **不会**对 HTTP 4xx/5xx 回退：那是服务端给出的**真实业务响应**
 *    （鉴权失败、参数错误、服务端故障），回退会用假数据把真实缺陷盖住。
 *
 * 公网服务器就位后，把这里改成 `'live'` 即可切回真实接口，业务代码零改动。
 */
export type DataMode = 'live' | 'demo' | 'auto';

export const DATA_MODE: DataMode = 'auto';
