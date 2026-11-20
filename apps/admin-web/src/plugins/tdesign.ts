/**
 * 管理后台的 TDesign **按需引入**（第三轮）。
 *
 * ## 为什么改
 *
 * 此前 `main.ts` 里是 `app.use(TDesign)`（默认导出 = 全量注册），
 * 于是**整个组件库**都进了首屏产物：
 * `tdesign-*.js` 1,356,203 B + `tdesign-*.css` 449,244 B。
 * 上一轮只是把它拆成了独立 chunk，**首屏下载量一点没降**（产物仍被预加载）。
 *
 * ## 现在的做法
 *
 * 只**注册真正用到的**组件（清单见下方 `COMPONENTS`），
 * 每个组件从**深路径**引入（`tdesign-vue-next/es/<组件>`），
 * 于是打包器能把没用到的组件整个摇掉。
 *
 * ## 组件清单怎么来的
 *
 * `infra/scripts/check-admin-web.mjs` 之外的另一个约束：
 * 模板里用到的每个 `t-*` 标签都必须在下面登记，否则运行时会渲染成未知元素。
 * 清单与 `grep -rho '<t-[a-z-]*' apps/admin-web/src --include=*.vue | sort -u` 的结果一一对应
 * （`t-alert t-button t-date-picker t-dialog t-drawer t-empty t-form t-form-item t-input
 *   t-input-number t-pagination t-radio-button t-radio-group t-select t-table t-tag t-textarea
 *   t-timeline t-timeline-item`）。
 *
 * ⚠️ **新增组件时必须同步这里** —— 少登记一个，那个标签就会在页面上变成空白。
 * 下面每个组件的注释里写明了它对应哪个标签。
 *
 * ## 样式
 *
 * 各组件的样式由组件模块自己 `import './style/css.mjs'` 带进来（按需），
 * 而**设计变量**（`--td-*`）集中在 `tdesign-vue-next/es/style/index.css` ——
 * 那一份必须**整份**引入（变量是全局的），单独引入。
 */
import type { App, Plugin } from 'vue';

// ---- 组件（按需引入：只引入真正用到的）--------------------------------
// t-alert / t-button / t-date-picker / t-dialog / t-drawer / t-empty /
// t-form + t-form-item / t-input / t-input-number / t-pagination /
// t-radio-group + t-radio-button / t-select / t-table / t-tag / t-textarea /
// t-timeline + t-timeline-item
import { Alert } from 'tdesign-vue-next/es/alert';
import { Button } from 'tdesign-vue-next/es/button';
import { DatePicker } from 'tdesign-vue-next/es/date-picker';
import { Dialog } from 'tdesign-vue-next/es/dialog';
import { Drawer } from 'tdesign-vue-next/es/drawer';
import { Empty } from 'tdesign-vue-next/es/empty';
import { Form, FormItem } from 'tdesign-vue-next/es/form';
import { Input } from 'tdesign-vue-next/es/input';
import { InputNumber } from 'tdesign-vue-next/es/input-number';
import { Pagination } from 'tdesign-vue-next/es/pagination';
import { RadioButton, RadioGroup } from 'tdesign-vue-next/es/radio';
import { Select } from 'tdesign-vue-next/es/select';
import { Table } from 'tdesign-vue-next/es/table';
import { Tag } from 'tdesign-vue-next/es/tag';
import { Textarea } from 'tdesign-vue-next/es/textarea';
import { Timeline, TimelineItem } from 'tdesign-vue-next/es/timeline';

// ---- 插件（命令式 API：MessagePlugin / DialogPlugin）------------------
// ⚠️ **不能**从 `tdesign-vue-next` 根入口引 —— 根入口 `es/index.mjs` 会把
//    整个组件库都拉进来（那正是本轮要消灭的）。
import { DialogPlugin } from 'tdesign-vue-next/es/dialog/plugin';
import { MessagePlugin } from 'tdesign-vue-next/es/message/plugin';

export { DialogPlugin, MessagePlugin };

// 设计变量（`--td-*`）：全局的一份，整份引入。
import 'tdesign-vue-next/es/style/index.css';

/**
 * 用到的组件（含子组件）。
 *
 * ⚠️ 每个组件的 `name` 就是模板里 `t-xxx` 标签对应的名字
 * （`TButton` ↔ `<t-button>`，Vue 会做 kebab-case ↔ PascalCase 的互转）。
 */
const COMPONENTS = [
  Alert, // t-alert
  Button, // t-button
  DatePicker, // t-date-picker
  Dialog, // t-dialog
  Drawer, // t-drawer
  Empty, // t-empty
  Form, // t-form
  FormItem, // t-form-item
  Input, // t-input
  InputNumber, // t-input-number
  Pagination, // t-pagination
  RadioButton, // t-radio-button
  RadioGroup, // t-radio-group
  Select, // t-select
  Table, // t-table
  Tag, // t-tag
  Textarea, // t-textarea
  Timeline, // t-timeline
  TimelineItem, // t-timeline-item
];

/**
 * 注册用到的 TDesign 组件（**不是**全量注册）。
 *
 * 用 `app.use(component)` 而不是 `app.component(name, component)`：
 * TDesign 的每个组件都带 `install`（`withInstall` 包装过），
 * `install` 内部按组件自己的 `name` 注册 —— 与官方全量注册走的是同一条路径。
 */
export function installTDesign(app: App): void {
  for (const component of COMPONENTS) {
    app.use(component);
  }
  // ⚠️ **插件必须单独 `use`**：它们的 `install` 把 app 的上下文（`app._context`）
  //    记在插件自己身上，命令式调用（`MessagePlugin.success(...)`、
  //    `DialogPlugin.confirm(...)`）要用它把弹层挂到**当前应用**上。
  //    此前全量注册（`app.use(TDesign)`）时这一步是顺带做的；
  //    改成按需引入后若漏掉，提示框 / 确认框会渲染不出来。
  //
  // ⚠️ 为什么断言成 `Plugin`：`MessagePlugin` 的类型是
  //    `Plugin & ExtraApi & MessageMethod`（**同时**是插件、命令式 API 与方法集），
  //    直接传给 `app.use()` 时 TypeScript 会挑中「命令式方法」那个调用签名，
  //    报「参数个数不对」。这里显式按 Vue 的 `Plugin` 断言，
  //    说的就是「请按插件安装它」这一件事。
  app.use(MessagePlugin as unknown as Plugin);
  app.use(DialogPlugin as unknown as Plugin);
}
