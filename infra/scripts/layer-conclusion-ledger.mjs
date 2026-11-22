#!/usr/bin/env node
/**
 * 「**结论台账**」的公共格式 —— 静态层与库内层的**逐条对账**用（第十七轮）。
 *
 * 背景（第十六轮 → 第十七轮）：
 *   第十六轮把两层的**判定口径**对齐了（实体 ↔ 迁移 与 实体 ↔ 库
 *   判同样的维度：类型 / 长度 / 可空性 / 默认值 / `unsigned` / 枚举取值）。
 *   但**口径一致 ≠ 结论一致** —— 两层各自报出的**结论**
 *   此前从未被自动比对过：
 *     - 「静态层说迁移里没有这道索引，库内层说库里**有**」→
 *       两层对同一个对象给出了互相矛盾的结论（其中一层解析错了，或
 *       库不是按迁移建的 / 建完被人手工改过）；
 *     - 「静态层判了这一列的默认值，库内层**根本没判这一列**」→
 *       一层**遗漏**了某个对象（表缺失时整表跳过、列缺失时整列跳过…）。
 *   这两类分叉此前**没有任何机制会报警**。
 *
 * 本模块定义两层共用的**台账格式**：
 *   - **维度**（dimension）：被判定的那一类东西（表 / 索引 / 外键 / 列 …）；
 *   - **对象**（object）：该维度下的**规范标识**（两层必须**逐字相同**，
 *     否则对账就成了「两堆不同的字符串比大小」）；
 *   - **判定**（status）：`OK`（一致）/ `MISMATCH`（不一致）/ `SKIPPED`
 *     （这一层**判不了**，例如库侧是 `CURRENT_TIMESTAMP(3)` 这类表达式，
 *     判不了就不判 —— 但**必须留痕**，否则「没判」与「判了没问题」分不开）。
 *
 * ⚠️ **为什么 `SKIPPED` 必须留痕**：
 *   只有把「跳过」也记下来，对账才能区分三种情况：
 *     - 两层都跳过 → 口径一致（都判不了）✓；
 *     - 一层跳过、一层判了 → **分叉**（一层比另一层多判了）✗；
 *     - 两层都判了但结论相反 → **矛盾** ✗。
 *   只记「不一致」的话，「一层压根没判」就会伪装成「一致」。
 *
 * ⚠️ **判定是「黏」的**（`MISMATCH` 优先于 `SKIPPED`，`SKIPPED` 优先于 `OK`）：
 *   同一个对象可能被同一条判定路径判好几次
 *   （例如唯一键那一列的长度既被「唯一键」那条路径判过、又被「列」那条路径判过）。
 *   黏性保证台账里每个对象**只有一条**结论，且结论取**最严重**的那条 ——
 *   否则「先报了不一致、后又记了一条正常」会把缺陷洗掉。
 *
 * 用法（两层各写一份台账）：
 *   const ledger = createLedger();
 *   recordVerdict(ledger, LEDGER_DIMENSIONS.COLUMN, 'alumni_profiles.display_name',
 *                 VERDICT.MISMATCH, 'MIGRATION_COLUMN_DEF_MISMATCH');
 *   // …对账见 check-layer-reconciliation.mjs
 */

/* ------------------------------ 维度 ------------------------------ */

/**
 * 台账的维度。
 *
 * ⚠️ 命名规则：`<维度>` = **正向**（实体声明 ↔ 参照物）；
 *   `<维度>_extra` = **反向**（参照物里有、实体里没声明）。
 *   两层的维度名必须**完全一致** —— 对账脚本按维度名配对。
 */
export const LEDGER_DIMENSIONS = {
  /** 表：实体声明了，参照物里有没有 */
  TABLE: 'table',
  /** 索引：实体声明的那条索引，参照物里对不对得上 */
  INDEX: 'index',
  /** 索引（反向）：参照物里多出来的索引 */
  INDEX_EXTRA: 'index_extra',
  /** 外键：实体声明的那条关系，参照物里对不对得上 */
  FOREIGN_KEY: 'foreign_key',
  /** 外键（反向）：参照物里多出来的外键 */
  FOREIGN_KEY_EXTRA: 'foreign_key_extra',
  /** 列：实体声明的那一列，参照物里对不对得上 */
  COLUMN: 'column',
  /** 列（反向）：参照物里多出来的列 */
  COLUMN_EXTRA: 'column_extra',
  /** 列的默认值 */
  COLUMN_DEFAULT: 'column_default',
  /** 列的无符号性 */
  COLUMN_UNSIGNED: 'column_unsigned',
  /** 列的枚举取值 */
  COLUMN_ENUM: 'column_enum',
  /** 唯一键：实体声明的那道唯一约束，参照物里有没有 */
  UNIQUE: 'unique',
};

/** 判定的三种状态。 */
export const VERDICT = {
  /** 判了，且一致 */
  OK: 'OK',
  /** 判了，且不一致 */
  MISMATCH: 'MISMATCH',
  /** 判不了（口径上不判这一项）—— 必须留痕，否则与「一致」分不开 */
  SKIPPED: 'SKIPPED',
};

/** 严重程度：数字越大越严重（用于「取最严重的那条」）。 */
const SEVERITY = {
  [VERDICT.OK]: 0,
  [VERDICT.SKIPPED]: 1,
  [VERDICT.MISMATCH]: 2,
};

/* ---------------------- 判定码 → 维度（两层各一张） ---------------------- */

/**
 * **静态层**（`check-error-semantics.mjs`，实体 ↔ 迁移）的判定码 → 维度。
 *
 * ⚠️ 只列**结构类**的判定码（表 / 索引 / 外键 / 列 / 唯一键）。
 *   错误语义类（唯一键登记表的处置、文档口径）**没有**库内对应物 ——
 *   它们不是「实体 ↔ 参照物」的判断，而是「代码 ↔ 文档」的判断。
 *   那些码**不出现**在对账范围内（不是「漏了」，是**本就不该比**）。
 *
 * ⚠️ `MIGRATION_UNIQUE_COLUMN_DEF_MISMATCH`（唯一键那一列的长度 / 可空性）
 *   归到 `column` 维度 —— 库内层把**每一列**的长度 / 可空性都判了
 *   （`DB_COLUMN_DEF_MISMATCH`），两者说的是**同一件事**，
 *   对账时必须归到同一个维度，否则会把「同一处不一致」算成两处。
 */
export const STATIC_ISSUE_DIMENSION = {
  MIGRATION_UNIQUE_MISSING: LEDGER_DIMENSIONS.UNIQUE,
  MIGRATION_UNIQUE_COLUMN_MISMATCH: LEDGER_DIMENSIONS.UNIQUE,
  MIGRATION_UNIQUE_COLUMN_DEF_MISMATCH: LEDGER_DIMENSIONS.COLUMN,
  MIGRATION_TABLE_MISSING: LEDGER_DIMENSIONS.TABLE,
  MIGRATION_INDEX_MISSING: LEDGER_DIMENSIONS.INDEX,
  MIGRATION_INDEX_TABLE_MISMATCH: LEDGER_DIMENSIONS.INDEX,
  MIGRATION_INDEX_COLUMN_MISMATCH: LEDGER_DIMENSIONS.INDEX,
  MIGRATION_INDEX_UNIQUENESS_MISMATCH: LEDGER_DIMENSIONS.INDEX,
  MIGRATION_COLUMN_MISSING: LEDGER_DIMENSIONS.COLUMN,
  MIGRATION_COLUMN_DEF_MISMATCH: LEDGER_DIMENSIONS.COLUMN,
  MIGRATION_COLUMN_DEFAULT_MISMATCH: LEDGER_DIMENSIONS.COLUMN_DEFAULT,
  MIGRATION_COLUMN_UNSIGNED_MISMATCH: LEDGER_DIMENSIONS.COLUMN_UNSIGNED,
  MIGRATION_COLUMN_ENUM_MISMATCH: LEDGER_DIMENSIONS.COLUMN_ENUM,
  // ⚠️ 静态层的外键判定码有**两个**名字（它们是同一件事的两种说法）：
  //   `ENTITY_FOREIGN_KEY_MISSING` —— 实体声明了关系，迁移里没建那道外键；
  //   `FOREIGN_KEY_TARGET_MISMATCH` —— 外键建了，但指向的表 / 列与实体说的不同。
  //   两者都是「**实体 ↔ 迁移**」的外键判定，
  //   与库内层的 `DB_FOREIGN_KEY_MISSING` / `DB_FOREIGN_KEY_TARGET_MISMATCH`
  //   **一一对应** → 必须归到**同一个维度**，否则对账会把同一处分叉算成两处。
  ENTITY_FOREIGN_KEY_MISSING: LEDGER_DIMENSIONS.FOREIGN_KEY,
  FOREIGN_KEY_TARGET_MISMATCH: LEDGER_DIMENSIONS.FOREIGN_KEY,
};

/**
 * **库内层**（`check-db-reality.mjs`，实体 ↔ 库）的判定码 → 维度。
 *
 * ⚠️ 两层的「反向」判定码（`*_NOT_DECLARED`：**参照物里有、实体里没声明**）
 *   **不参与**逐条对账 —— 理由写在 `RECONCILABLE_DIMENSIONS` 的注释里。
 */
export const DB_ISSUE_DIMENSION = {
  DB_UNIQUE_MISSING: LEDGER_DIMENSIONS.UNIQUE,
  DB_TABLE_MISSING: LEDGER_DIMENSIONS.TABLE,
  DB_INDEX_MISSING: LEDGER_DIMENSIONS.INDEX,
  DB_INDEX_COLUMN_MISMATCH: LEDGER_DIMENSIONS.INDEX,
  DB_INDEX_UNIQUENESS_MISMATCH: LEDGER_DIMENSIONS.INDEX,
  DB_FOREIGN_KEY_MISSING: LEDGER_DIMENSIONS.FOREIGN_KEY,
  DB_FOREIGN_KEY_TARGET_MISMATCH: LEDGER_DIMENSIONS.FOREIGN_KEY,
  DB_COLUMN_MISSING: LEDGER_DIMENSIONS.COLUMN,
  DB_COLUMN_DEF_MISMATCH: LEDGER_DIMENSIONS.COLUMN,
  DB_COLUMN_DEFAULT_MISMATCH: LEDGER_DIMENSIONS.COLUMN_DEFAULT,
  DB_COLUMN_UNSIGNED_MISMATCH: LEDGER_DIMENSIONS.COLUMN_UNSIGNED,
  DB_COLUMN_ENUM_MISMATCH: LEDGER_DIMENSIONS.COLUMN_ENUM,
};

/**
 * **可以逐条对账的维度**（两层都有、且语义一致）。
 *
 * ⚠️ 「反向」维度（`*_extra`）**不在**其中，理由逐条写明：
 *   - `unique_extra`：两层的「反向唯一键」口径不同 ——
 *     静态层判的是「迁移里有、实体没声明」，
 *     库内层判的是「库里有、登记表与迁移里都没有」（来源不明的约束）。
 *     两者**不是同一个问题**，硬比会报出一堆假矛盾。
 *   - `index_extra` / `foreign_key_extra` / `column_extra`：
 *     「参照物里多出来的东西」在**迁移**与**库**之间本就可以不同
 *     （迁移里的 `down()` 回滚、MySQL 自动建的外键支撑索引…），
 *     且两层对「多出来的东西」的排除规则本就不同
 *     （库内层还要排除 MySQL 自动建的外键支撑索引）。
 *     这一层由**各自**的反向判定码守着（`MIGRATION_INDEX_NOT_DECLARED`
 *     与 `DB_INDEX_NOT_DECLARED`），不跨层硬比。
 */
export const RECONCILABLE_DIMENSIONS = [
  LEDGER_DIMENSIONS.TABLE,
  LEDGER_DIMENSIONS.UNIQUE,
  LEDGER_DIMENSIONS.INDEX,
  LEDGER_DIMENSIONS.FOREIGN_KEY,
  LEDGER_DIMENSIONS.COLUMN,
  LEDGER_DIMENSIONS.COLUMN_DEFAULT,
  LEDGER_DIMENSIONS.COLUMN_UNSIGNED,
  LEDGER_DIMENSIONS.COLUMN_ENUM,
];

/**
 * **明确「不参与跨层对账」的判定码**（附理由）。
 *
 * ⚠️ **为什么要有这份「不参与」清单**（而不是「没归维度的码就当缺陷」）：
 *   两层里有相当一部分判定码，判的是**「代码 ↔ 文档 / 登记表」**，
 *   而不是**「实体 ↔ 参照物」** —— 库内层**根本没有**对应的概念
 *   （库里没有「API-SPEC 文档」，也没有「唯一键登记表」）。
 *   这些码**本就不该**跨层比，硬比只会报出一堆假矛盾。
 *
 * ⚠️ 但「本就不该比」必须**逐条写明理由** ——
 *   否则「忘了归维度」与「有意不比」就分不开了，
 *   而前者正是**漏判**（这个判定码的结论没人交叉验证）。
 *   对账脚本（`check-layer-conclusion-reconciliation.mjs`）据此把
 *   「既没归维度、也没列入本清单」的判定码报成
 *   `LAYER_ISSUE_CODE_UNMAPPED`。
 *
 * 分三类：
 *   ① **文档类**：判的是「文档里有没有写清这一条」；
 *   ② **登记表类**：判的是「唯一键的**处置口径**登记了没有」；
 *   ③ **反向类**：判的是「参照物里**多出来**的东西」——
 *      两层对「多出来」的基线本就不同（详见 `RECONCILABLE_DIMENSIONS` 的注释）。
 */
export const NON_RECONCILABLE_CODES = {
  /* ---------------------------- ① 文档类 ---------------------------- */
  DOC_INDEX_LIST_MISSING: '文档类：判的是「文档的索引清单里有没有这一条」—— 库内层没有「文档」这个对象',
  DOC_INDEX_NOT_IN_MIGRATION: '文档类：判的是「文档里写的索引名在迁移里找不到」',
  MIGRATION_INDEX_NOT_IN_DOC: '文档类：判的是「迁移里的索引在文档里没写」',
  ERROR_SEMANTICS_SECTION_MISSING: '文档类：判的是「API-SPEC 里有没有错误语义这一节」',
  ERROR_SEMANTICS_UNDOCUMENTED: '文档类：判的是「这个唯一键在文档里没写清处置」',

  /* -------------------------- ② 登记表类 --------------------------- */
  UNIQUE_COLUMN_NOT_REVIEWED: '登记表类：判的是「这个唯一键有没有登记处置」—— 库内层没有「登记表」这个对象',
  REVIEWED_COLUMN_MISSING: '登记表类：判的是「登记了的唯一键在实体里找不到」',
  MISSING_CONFLICT_MAPPING: '登记表类：判的是「登记的处置里有没有写撞键怎么处置」',
  MISSING_GUARD: '登记表类：判的是「登记的处置里有没有写守卫」',
  UNKNOWN_DISPOSITION: '登记表类：判的是「登记的处置值认不认识」',
  REGISTRY_ENTITY_MISMATCH: '登记表类：判的是「登记的实体名与实际对不对得上」',

  /* --------------------------- ③ 反向类 --------------------------- */
  MIGRATION_UNIQUE_NOT_DECLARED: '反向类：判的是「迁移里有、实体没声明」—— 与库内层的反向基线不同（见 RECONCILABLE_DIMENSIONS 注释）',
  MIGRATION_INDEX_NOT_DECLARED: '反向类：判的是「迁移里有、实体没声明」',
  MIGRATION_FOREIGN_KEY_NOT_DECLARED: '反向类：判的是「迁移里有、实体没声明」',
  MIGRATION_COLUMN_NOT_DECLARED: '反向类：判的是「迁移里有、实体没声明」',
  DB_UNIQUE_NOT_DECLARED: '反向类：判的是「库里有、登记表与迁移里都没有」—— 与静态层的反向基线不同',
  DB_INDEX_NOT_DECLARED: '反向类：判的是「库里有、实体没声明」',
  DB_FOREIGN_KEY_NOT_DECLARED: '反向类：判的是「库里有、实体没声明」',
  DB_COLUMN_NOT_DECLARED: '反向类：判的是「库里有、实体没声明」',
};

/* ------------------------------ 台账 ------------------------------ */

/** 新建一份空台账。 */
export function createLedger() {
  return new Map();
}

/**
 * 记一条判定。
 *
 * @param {Map} ledger 台账（`createLedger()` 建的）
 * @param {string} dimension 维度名（`LEDGER_DIMENSIONS` 之一）
 * @param {string} object 对象标识（用下面的 `objectKey*` 生成，**两层必须一致**）
 * @param {string} status `VERDICT` 之一
 * @param {string|null} code 该层的判定码（不一致时给出，便于人一眼看出是哪一类）
 * @param {string|null} detail 补充说明（可选）
 */
export function recordVerdict(ledger, dimension, object, status, code = null, detail = null) {
  const key = `${dimension} ${object}`;
  const existing = ledger.get(key);
  // ⚠️ **黏性**：同一个对象判多次时，保留**最严重**的那条结论
  //    （MISMATCH > SKIPPED > OK）—— 否则后记的一条「正常」会把先记的缺陷洗掉。
  if (existing && SEVERITY[existing.status] >= SEVERITY[status]) {
    // 同一严重程度：保留**先记**的那条（判定码更具体，通常先记的更贴切）。
    if (SEVERITY[existing.status] === SEVERITY[status] && existing.status === status) {
      if (!existing.codes.includes(code) && code) existing.codes.push(code);
    }
    return existing;
  }
  const entry = { dimension, object, status, codes: code ? [code] : [], detail };
  ledger.set(key, entry);
  return entry;
}

/**
 * 把台账按维度归并成「维度 → 对象 → 结论」。
 *
 * @param {Map} ledger 台账
 * @returns {{byDimension: Map<string, Map<string, object>>}}
 */
export function indexLedger(ledger) {
  const byDimension = new Map();
  for (const entry of ledger.values()) {
    if (!byDimension.has(entry.dimension)) byDimension.set(entry.dimension, new Map());
    byDimension.get(entry.dimension).set(entry.object, entry);
  }
  return { byDimension };
}

/* ---------------------------- 对象标识 ---------------------------- */

/**
 * 对象标识的规范形式。
 *
 * ⚠️ **两层必须逐字相同**，否则对账无从谈起 ——
 *   所以这些函数被抽到**公共模块**里，两层都调它，
 *   而不是各写一份（各写一份迟早会漂）。
 *
 * 统一约定：**一律小写**（MySQL 的表名 / 列名本来就不区分大小写；
 *   实体声明里写的表名与迁移里写的表名大小写却可能不同）。
 */

/** 表。 */
export function objectKeyTable(table) {
  return String(table).toLowerCase();
}

/** 索引：`表.索引名`。 */
export function objectKeyIndex(table, name) {
  return `${String(table).toLowerCase()}.${String(name).toLowerCase()}`;
}

/** 列 / 外键列：`表.列名`（外键按它落在哪一列上标识）。 */
export function objectKeyColumn(table, column) {
  return `${String(table).toLowerCase()}.${String(column).toLowerCase()}`;
}

/**
 * 唯一键：`表.列1+列2`（列名**排序后**用 `+` 连接）。
 *
 * ⚠️ 为什么要排序：同一道唯一键，在实体里声明的顺序与在迁移 / 库里
 *   建的顺序可能不同（`uk_contact_grant` 是 `(pair_id, user_id)`，
 *   别处可能是 `(user_id, pair_id)`）—— 不排序就会把**同一道**唯一键
 *   当成两道，对账立刻报「一边多一道」。
 */
export function objectKeyUnique(table, columns) {
  const sorted = [...columns].map((column) => String(column).toLowerCase()).sort();
  return `${String(table).toLowerCase()}.${sorted.join('+')}`;
}
