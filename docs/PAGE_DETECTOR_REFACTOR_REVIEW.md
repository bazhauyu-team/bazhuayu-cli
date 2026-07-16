# page-detector 重构审查说明

> **文档用途**：给同事 / reviewer 对照**当前未提交工作区**做代码检查。
> **仓库**：`bazhuayu-cli`
> **基线分支**：`main`（与 `origin/main` 同步）
> **基线 commit（撰写时）**：`41fb8af` — *Harden template-task --param validation and agent error codes.*
> **文档日期**：2026-07-10
> **变更状态**：**尚未 commit / push**

---

## 1. 审查结论应关注什么

本次变更主体是 **结构性重构（structural refactor）**，不是功能需求交付；同时包含两项明确披露的 `detectPage` 清理安全修复（见 §4.2 E），因此不能把整批改动笼统视为逐字机械搬迁。

| 应重点查 | 不必当主目标查 |
|---------|----------------|
| 检测行为是否与拆分前一致；清理修复是否正确 | 算法是否「更准」 |
| 模块边界与依赖方向 | 行数是否「够小」 |
| 测试导出面是否破坏 | UI 文案是否改写 |
| `engine-host` 类型收窄是否改语义 | 性能是否优化 |
| 有无循环依赖 / 死代码 import | 是否顺带改了 CLI 参数 |

**推荐审查口令**：

```bash
git status --short
# 注意：普通 git diff 不显示 untracked 新文件，只能看到 tracked 修改文件
git diff --stat HEAD
# 如需完整统一 diff，可先把新文件登记为 intent-to-add（不会暂存文件内容，但会修改 index）
git add --intent-to-add -- 'docs/PAGE_DETECTOR_REFACTOR_REVIEW.md' 'src/runtime/detector/page-detector-*.ts'
git diff --stat HEAD -- 'docs/PAGE_DETECTOR_REFACTOR_REVIEW.md' 'src/runtime/detector' 'src/runtime/engine-host.ts' 'test/detector.test.mjs' 'test/cli-contract.test.mjs'
git diff HEAD -- 'docs/PAGE_DETECTOR_REFACTOR_REVIEW.md' 'src/runtime/detector' 'src/runtime/engine-host.ts' 'test/detector.test.mjs' 'test/cli-contract.test.mjs'
npm run typecheck
npm test
```

> `git add --intent-to-add` 仅用于让 Git 把未跟踪文件纳入 diff；执行前应确认当前 index 可以修改。若不希望触碰 index，可对每个新文件使用 `git diff --no-index -- /dev/null '<file>'`。

最终合入验证状态以 §7 为准；不要把拆分早期快照的测试结果当作当前工作区结论。

---

## 2. 背景与动机

### 2.1 问题

`src/runtime/detector/page-detector.ts` 在基线上约 **11 827 行**，同时承载：

- 浏览器 / extension host 生命周期
- 登录干预、搜索提交、翻页交互
- 候选检测策略与编排
- 字段精炼、弹窗、overlay、滚动探针
- 大量 `*ForTesting` 导出

单文件导致：难 review、难定位、改一处风险面过大、类型边界模糊（尤其 `engine-host` 对 proprietary runtime 的 `any`）。

### 2.2 目标（已完成范围）

1. **P0**：按领域拆分 `page-detector`，门面只做编排与 re-export。
2. **P1**：
   - 策略实现 vs 编排分离
   - host 用最小接口解耦（避免子模块依赖完整 host 类）
   - `engine-host.ts` 去掉 `any`，改为窄接口 + `unknown` 收窄
3. **约束**：
   - 检测业务行为尽量不变（机械搬迁为主）
   - 仅明确修复异常清理与 stdio 原始 writer 恢复问题（见 §4.2 E）
   - 测试仍从门面取 `*ForTesting`
   - **不 commit**（由负责人决定何时提交）
   - 不碰无关文件（如 untracked `.npmrc`）

### 2.3 明确不做

- 不改 detect 业务算法正确性目标
- 不为拆而拆：`pagination` / `candidate-strategies` / `fields` 仍偏大，但职责已单一
- 不改 CLI 协议、任务 schema、agent plan 协议（除非 re-export 路径需要）

---

## 3. 变更清单（工作区）

### 3.1 修改的文件

| 文件 | 基线 → 现状（约） | 说明 |
|------|------------------|------|
| `src/runtime/detector/page-detector.ts` | 11827 → **408** | 瘦门面：`detectPage` + 测试 re-export + 少量胶水/清理安全修复 |
| `src/runtime/engine-host.ts` | 676 → **764** | 类型边界：`WorkflowAgentLike` 等；`any` → 0 |
| `test/detector.test.mjs` | tracked 修改 | 门面 31 个导出的精确集合断言；`detectPage` 三个异常清理测试 |
| `test/cli-contract.test.mjs` | tracked 修改 | runtime 必需方法、captcha / proxy 缺失能力与控制转发测试 |

普通 `git diff --stat HEAD`（量级）：

```
src/runtime/detector/page-detector.ts | ~11k 行净删（逻辑迁出）
src/runtime/engine-host.ts            | ~160 行量级类型改动
test/detector.test.mjs                | 门面契约与 detectPage 失败路径测试
test/cli-contract.test.mjs            | engine-host 行为契约测试
```

这里的输出**不包含重构主体**：17 个新 `page-detector-*` 模块仍是 untracked，普通 `git diff` 不会显示其内容。完整审查必须结合 `git status --short`，并使用 §1 的 intent-to-add 或 `git diff --no-index` 方式读取新文件。

### 3.2 新增的代码文件（17 个，均在 `src/runtime/detector/`）

| 文件 | 约行数 | 职责一句话 |
|------|--------|------------|
| `page-detector-shared.ts` | 138 | 共享类型（RawCandidate、Search*、ScrollProbe、console 等） |
| `page-detector-utils.ts` | 94 | 纯工具函数 |
| `page-detector-host.ts` | 236 | `ExtensionDetectorHost`：Chrome / extension / bridge 生命周期 |
| `page-detector-scroll.ts` | 208 | 自动滚动、settle、scroll probe |
| `page-detector-page-scoring.ts` | 415 | 多标签评分与采纳；`PageAdoptionHost` |
| `page-detector-candidates.ts` | 163 | 候选检测**编排** |
| `page-detector-candidate-strategies.ts` | 1705 | 候选检测**策略实现** |
| `page-detector-fields.ts` | 1543 | 字段精炼 / 相邻元数据 |
| `page-detector-pagination.ts` | 1835 | 翻页检测算法主体 |
| `page-detector-pagination-ui.ts` | 167 | 交互式确认翻页 |
| `page-detector-search.ts` | 1189 | 搜索框 / 提交按钮底层解析与点击 |
| `page-detector-search-flow.ts` | 575 | 搜索提交与输入确认流程；`SearchFlowHost` |
| `page-detector-popup.ts` | 510 | 遮挡 / 登录弹窗检测与关闭 |
| `page-detector-overlay.ts` | 979 | 通用 manual overlay / live menu |
| `page-detector-browser-overlays.ts` | 1243 | 页内高亮 / 选区脚本（候选、详情等） |
| `page-detector-manual-ui.ts` | 468 | 选候选、选详情字段等人工流程 |
| `page-detector-login.ts` | 291 | 登录干预、会话保存、manual continue、`DetectionLoginRequiredError` |

**合计**：`page-detector*` + `engine-host` 约 **12 931** 行（拆分后代码总量与原巨石同量级，属预期）。

此外新增本审查文档 `docs/PAGE_DETECTOR_REFACTOR_REVIEW.md`。因此当前相关工作区共包含：**4 个 tracked 修改文件（2 个实现 + 2 个测试）+ 18 个 untracked 文件（17 个代码模块 + 1 个文档）**。

---

## 4. 目标架构

```
page-detector.ts                    # 门面：detectPage 编排 + *ForTesting re-export
│
├── page-detector-host.ts           # 浏览器 / extension host
├── page-detector-page-scoring.ts   # 多标签评分 / 采纳
├── page-detector-login.ts          # 登录干预 / 会话
├── page-detector-search-flow.ts    # 搜索提交流程（auto + manual）
├── page-detector-pagination-ui.ts  # 翻页交互 UI
│
├── page-detector-candidates.ts     # 候选编排
│     └── page-detector-candidate-strategies.ts
├── page-detector-fields.ts
├── page-detector-pagination.ts     # 翻页算法
├── page-detector-search.ts         # 搜索底层
├── page-detector-popup.ts
│
├── page-detector-manual-ui.ts
│     └── page-detector-browser-overlays.ts
├── page-detector-overlay.ts
├── page-detector-scroll.ts
│
├── page-detector-shared.ts
└── page-detector-utils.ts

engine-host.ts                      # 独立：运行时宿主类型收窄（非 detector 子图）
```

### 4.1 门面现在做什么

`page-detector.ts` 主要保留：

1. **对外稳定出口**：全部 `*ForTesting` 与部分 ranking / api-list re-export
2. **`detectPage` 主流程**（顺序概览）：
   - 启动 `ExtensionDetectorHost` + API response capture
   - 登录干预 / 弹窗处理
   - 可选搜索（input overrides → submit / manual submit → 结果页校验）
   - 滚动探针 → `detectCandidates`
   - 交互：选候选 / 翻页 / 详情
   - diagnostics / screenshot / apiCandidates / 可选存 session
3. **胶水**：`suppressDetectorRuntimeConsole`、`dedupeApiListCandidates`、`updateSearchPlanFinalUrl`

### 4.2 关键设计决策

#### A. 策略 vs 编排（candidates）

- **编排**（`page-detector-candidates.ts`）：
  protected-smart / fallback 合并、去重、layout score、pagination attach、goal/LLM rank 准备
- **策略**（`page-detector-candidate-strategies.ts`）：
  `detectTables`、`detectRepeatedCards`、`detectSearchResultBlocks`、`detectSemanticBusinessCards`、`detectDeptaCandidates`、`detectDetails`、`detectForms`、`detectLinkCollections` 等

避免「再拆一个 1700 行策略文件却和编排缠在一起」。

#### B. Host 最小接口（解耦）

子模块不直接依赖完整 `ExtensionDetectorHost` 类实现细节，而是用结构类型：

| 接口 | 定义位置 | 用途 |
|------|----------|------|
| `PageAdoptionHost` | `page-detector-page-scoring.ts` | `page` / `browser()` / `usePage` |
| `SearchFlowHost` | `page-detector-search-flow.ts` | 上述 + `refreshTabId` / `command` |
| `SearchDetectorHost` | `page-detector-search.ts` | 底层搜索点击用的更窄 host |

`ExtensionDetectorHost` 结构上满足这些接口，门面把具体 host 实例传入即可。

#### C. 测试契约（必须保持）

测试（`test/detector.test.mjs` 等）从编译产物导入：

```js
from '../dist/runtime/detector/page-detector.js'
```

门面对外契约包含 `detectPage`，并继续 **re-export** 下列符号（名称勿改）：

- Overlay：`showManualOverlayForTesting`、`readManualOverlaySelectionForTesting`、`resetManualOverlayHintKeysForTesting`、`writeManualOverlayHintOnceForTesting`
- Popup：`detectPageObstructionsForTesting`、`dismissPageObstructionsForTesting`、`confirmManualPopupDismissalForTesting`
- Fields：`refineCandidateFieldsForTesting`、`augmentAdjacentMetadataFieldsForTesting`
- Pagination：`detectPaginationForCandidatesForTesting`、`sanitizeCandidatePaginationByLayoutForTesting`、`detectInteractivePaginationOptionsForTesting`、`isPlausiblePaginationOptionForTesting`、`preferredPaginationForTesting`
- Candidates：`detectSearchResultBlocksForTesting`、`detectSemanticBusinessCardsForTesting`
- Search：`findSearchInputCandidatesForTesting`、`resolveSearchSubmitButtonForTesting`、`resolveSearchSubmitButtonByGeometryForTesting`
- Manual UI：`selectDetailUrlFieldForTesting`
- Scoring：`scoreSearchResultPageForTesting`、`pageLooksLikeSearchResultForTesting`
- Login：`DetectionLoginRequiredError`、`shouldPromptForLoginInterventionForTesting`
- Ranking / API：`applyGoalScoresForTesting`、`rankCandidatesForTesting`、`dedupeEquivalentCandidates`、`filterDetectedBoilerplateCandidates`、`detectApiListCandidatesForTesting`、`detectKnownApiListCandidatesForTesting`

当前测试边界需要单独看待：

- `test/detector.test.mjs` 已通过 namespace import 对 `Object.keys(pageDetectorFacade)` 做精确集合断言，锁定全部 **31 个**运行时导出。此前未被具名导入覆盖的 `showManualOverlayForTesting`、`readManualOverlaySelectionForTesting`、`confirmManualPopupDismissalForTesting`、`DetectionLoginRequiredError` 也已纳入。
- `detectPage` 目前有三个直接单测，分别验证 host 启动失败时恢复 stdio、下游初始化失败时关闭 host、`host.close()` 自身失败时仍恢复 stdio。这些是 mock 的异常路径，不是成功路径的浏览器集成测试。
- 登录、搜索重放、API capture、多标签页采纳、人工交互与正常收尾的组合顺序仍未被自动化端到端覆盖；本轮已用 §7 的两条真实浏览器 smoke 验证主编排，后续相关改动仍需复跑。

审查时建议：

```bash
rg -n 'ForTesting' src/runtime/detector/page-detector.ts
rg -n 'pageDetectorFacade|expectedExports' test/detector.test.mjs
rg -n '\.detectPage\(|\bdetectPage\(' test
```

#### D. `engine-host` 类型收窄

- 新增 `WorkflowAgentLike` / `WorkflowAgentConstructor`（`WorkflowBrowserLike` 已在 browser-runtime 迁移中移除：Chrome 生命周期由 `WorkflowAgent.close()` 管理）
- workflow 事件载荷用 `unknown`，并在读取前经过 `asWorkflowMessage`、`asRecord` 或对应 normalize 函数
- bridge 诊断事件仅用 `Bridge*Event` 接口做**静态参数标注**；没有运行时 payload 校验或 narrowing，字段只用于日志
- `private workflow: WorkflowAgentLike | null`
- `stop` / `stopTask` / `pauseTask` / `resumeTask` / `close` / `capthcaToken` / `sendProxy` 是必需能力并保持直接调用；方法缺失会失败，不会静默 no-op 或上报假成功
- **刻意保留**：`ExtraData` 里 `total` 赋值语义与原 `message?.data?.total ?? total` 一致（仅在 `total` 非 `null`/`undefined` 时更新）
- `test/cli-contract.test.mjs` 新增缺失 captcha / proxy handler 时只报 `failed`、不得假报 `resolved` / `sent` 的测试，并验证 stop / pause / resume / close 的控制转发

审查关注点：workflow 事件处理是否因 narrowing 漏字段；bridge 日志边界的静态标注是否与实际 emitter payload 一致；必需 runtime 方法是否继续保持基线的失败语义。

#### E. 非机械的清理安全修复（`detectPage`）

这两项是相对基线的有意行为修复，不属于文件搬迁：

1. `detectPage` 的外层清理由嵌套 `try/finally` 保证：即使 `host.close()` reject，`runtimeConsole.restoreOriginal()` 仍会执行；`close` 错误继续向调用方传播。
2. `suppressDetectorRuntimeConsole` 在创建时保存原始 `process.stdout.write` / `process.stderr.write` 引用，`restoreOriginal()` 精确恢复这两个 raw writer，保持引用身份，而不是留下过滤 wrapper 或绑定后的替代函数。

这修复了失败路径可能污染后续 CLI 命令或测试进程 stdio 的问题。三个直接异常测试用引用身份断言覆盖 start 失败、downstream setup 失败和 host cleanup 失败；检测算法与正常结果结构没有在这里改动。

---

## 5. 模块依赖关系（`page-detector*`）

依赖方向（摘要，仅 `./page-detector-*` 边）：

```
utils → shared
host → shared, utils
scroll → shared, utils
overlay → shared, utils
pagination → shared, utils
search → shared, utils
popup → shared, overlay, utils
page-scoring → shared, utils, scroll, search
candidate-strategies → shared, utils, search
fields → ∅（仅指 page-detector 子图；该模块只依赖 Puppeteer 类型与 detector types）
candidates → shared, utils, fields, pagination, candidate-strategies
browser-overlays → pagination
manual-ui → shared, overlay, candidates, scroll, utils, browser-overlays
login → shared, overlay, popup, utils, scroll, page-scoring
search-flow → shared, overlay, utils, scroll, search, page-scoring
pagination-ui → shared, overlay, pagination, utils, manual-ui
page-detector (facade) → host, login, search-flow, pagination-ui, scoring, candidates, …
```

**无环**：对 `src/runtime/detector/page-detector*.ts` 做过 DFS 环检测，结果为无环。

审查时可用：

```bash
# 快速看互相引用
rg -n "from '\\./page-detector" src/runtime/detector/page-detector*.ts
```

---

## 6. 建议的审查路径（按优先级）

### P0 — 正确性与契约（必看）

1. **`detectPage` 控制流**（`page-detector.ts`）
   - 登录 → 搜索 → 滚动 → 检测 → 交互 → 收尾 顺序是否完整
   - `ignoreLoginInterventionPrompts`、search replay、结果页校验是否还在

2. **搜索路径**（`page-detector-search-flow.ts` + `page-detector-search.ts`）
   - auto：`submitInputs` / `retrySearchWithEnter`
   - manual：`submitInputsManually` / submit picker
   - enter / geometry fallback 是否齐全

3. **登录路径**（`page-detector-login.ts`）
   - 非 interactive 抛 `DetectionLoginRequiredError`
   - interactive overlay + CLI fallback
   - `mergeLoginIntervention` 合并规则

4. **候选路径**（`candidates` + `candidate-strategies` + `fields` + `pagination`）
   - legacy vs protected-smart 分支
   - `*ForTesting` 是否仍指向原策略函数

5. **`engine-host` ExtraData / captcha / proxy**
   - workflow 事件回调是否仍能更新 `total` / 触发 billing
   - captcha / proxy 发送和 stop / pause / resume / close 是否保持直接调用与失败语义
   - bridge 事件类型只是日志字段的静态标注，不应误认为存在运行时校验

### P1 — 结构与可维护性

1. 新模块是否「名副其实」（有无跨领域硬塞）
2. 是否出现「门面再膨胀」：业务逻辑是否又写回 `page-detector.ts`
3. 大文件（pagination / strategies / fields）是否**暂时可接受**（见 §9）
4. 是否有循环依赖、双向 import

### P2 — 代码卫生

1. 未使用 import / 重复 export
2. 注释是否误导（旧路径注释）
3. `page.evaluate` 内联脚本是否在搬家时被截断

---

## 7. 验证记录

下表区分“需要执行的合入检查”和“测试本身能证明什么”。结果均针对最终工作区：新增第三条 cleanup 测试后，detector 聚焦测试 128 / 128、最终全量测试 222 / 222 通过。

| 检查项 | 命令 / 方法 | 当前状态 | 能证明 / 不能证明 |
|--------|-------------|----------|-------------------|
| Typecheck | `npm run typecheck`（也由 `npm test` 执行） | **通过** | 证明 TypeScript 边界可编译；不证明 runtime payload 形状 |
| 全量测试 | `npm test`（含 typecheck + build + `test/*.test.mjs`） | **222 / 222 pass / 0 fail** | 覆盖现有单元/契约测试；不覆盖 `detectPage` 成功路径的真实浏览器编排 |
| 门面导出集合 | 构建产物 namespace 的 31 个符号精确集合断言 | **通过** | 锁定 facade 兼容导出；不证明实现行为 |
| `detectPage` 异常清理 | mock host start / downstream setup / host cleanup 失败 | **3 / 3 通过**（detector 聚焦测试 128 / 128） | 证明三个异常清理分支与 raw writer 引用恢复；不证明成功主流程 |
| `engine-host` 必需能力 | 缺失 captcha / proxy handler + 控制方法转发测试 | **通过** | 防止假成功和控制静默 no-op；不验证真实 proprietary runtime |
| 导入环 | 对 `page-detector*.ts` 做 DFS | **18 files / 64 unique edges / 0 cycles** | 证明该子图无环 |
| `engine-host` 中 `any` | `rg '\bany\b' src/runtime/engine-host.ts` | **无匹配** | 只证明显式 `any` 已移除 |
| Diff 卫生 | tracked `git diff --check`；TS / 测试文件尾随空白扫描 | **通过 / 无匹配** | 检查空白错误；不检查行为 |
| 公开列表页 smoke | 本地 fixture + 正式 CLI + engine Chrome for Testing 147 + `--legacy-detector` | **通过** | `exit 0` / `ok: true`；覆盖主编排、候选检测和清理路径 |
| 带搜索页 smoke | 同一环境，输入 `q=orion` | **通过** | `exit 0` / `ok: true`；覆盖搜索提交、结果页采纳和后续检测 |

Smoke 使用仅监听 `127.0.0.1:4877` 的本地 fixture、正式 CLI、engine 缓存的 Chrome for Testing 147 和 `--legacy-detector`：

- 公开列表页：`exit 0`、`ok: true`，`finalUrl=/list`；主候选 `search_results_1`，10 items / 4 fields。
- 带搜索页：提交 `q=orion` 后 `exit 0`、`ok: true`，`finalUrl=/results?q=orion`；`searchPlan` 记录 input `q` 与 click `Search`，主候选 10 items / 4 fields。

第一次尝试使用系统 branded Google Chrome 150 时因 `Extension did not register` 失败；改用 engine-managed Chrome for Testing 147 后两条均通过。该 smoke 必须使用支持 `--load-extension` 的 Chrome for Testing / engine browser，不能把 branded Chrome 150 的 extension 注册失败归为 detector 回归。由于本次 smoke 显式使用 `--legacy-detector`，它验证的是主编排与 legacy detector 路径，不替代 protected-smart 路径的专项验证。

> 自动化验证期间 `doctor verifies Chrome launch` 也曾偶发失败一次；该测试不在本轮修改路径内，单独复跑通过，随后完整重跑 222 / 222 通过。当前自动化与两条真实浏览器 smoke 的合入门槛均已满足。

---

## 8. 风险与已知局限

| 风险 | 说明 | 缓解 |
|------|------|------|
| 机械搬迁遗漏 | 大文件切片可能漏函数、改调用顺序或遗漏兼容导出 | 完整导出集合断言 + 基线对照 + 两条浏览器 smoke |
| 类型 narrowing 改变运行时 | `engine-host` 对 workflow 的 `unknown` 判断过严会丢字段 | 对照 ExtraData 原语义；必需 runtime 方法保持直接调用；重点看事件路径 |
| 进程 stdio 污染 | 基线在 `host.close()` reject 时可能跳过原始 writer 恢复 | 嵌套 `try/finally` + raw writer 引用身份断言覆盖三个异常分支 |
| 主编排自动化覆盖不足 | 自动化测试只直接执行 `detectPage` 的三个异常分支；成功组合仍无端到端自动化 | 公开列表页与带搜索页真实浏览器 smoke 已通过；后续改动仍需复跑 |
| 浏览器 extension 能力差异 | 系统 branded Chrome 150 在本环境无法注册 detector extension，表现为 `Extension did not register` | smoke 使用支持 `--load-extension` 的 engine-managed Chrome for Testing；不要误判为 detector 回归 |
| 大文件仍在 | pagination ~1835、strategies ~1705、fields ~1543 | 职责已分离；非本轮必拆 |
| 未提交体积大 | 17 个新代码文件 + 1 个新文档 + 4 个修改文件；普通 diff 漏掉 untracked 内容 | 使用 §1 的完整 diff 方法；建议按 detector / engine-host / 文档切分 commit |

---

## 9. 刻意保留的「大文件」

以下文件**有意未再切**（拆了也难独立测试、且当前无编辑热点）：

| 文件 | 约行数 | 为何先不动 |
|------|--------|------------|
| `page-detector-pagination.ts` | 1835 | 翻页启发式高度内聚 |
| `page-detector-candidate-strategies.ts` | 1705 | 多策略同文件便于对照；已与编排分离 |
| `page-detector-fields.ts` | 1543 | 字段命名 / 清洗规则集中 |
| `page-detector-browser-overlays.ts` | 1243 | 浏览器侧脚本字符串集中 |
| `page-detector-search.ts` | 1189 | submit 解析与点击一体 |

若后续某文件成为冲突热点，再按**策略函数边界**二次拆分即可。

---

## 10. 建议的 commit 切分（可选）

负责人若要提交，可参考（**本文不代替 commit**）：

1. **refactor(detector): split page-detector into domain modules**
   - 全部 `page-detector-*` + 门面瘦身 + cleanup 安全修复 + `test/detector.test.mjs` 的契约/清理测试
2. **refactor(runtime): tighten engine-host typing**
   - `engine-host.ts` + `test/cli-contract.test.mjs` 的 runtime 行为测试
3. （可选）文档：本审查说明入库

或合并为单一 refactor commit；只有最终验证全部完成后，commit message 才能写明 tests green。

---

## 11. 审查检查清单（可勾选）

- [x] `git status` 仅见 detector / engine-host / 对应测试 / 本文档，无意外文件
- [x] 审查已包含 17 个 untracked 代码模块，而非只看 tracked diff
- [x] `npm run typecheck` 通过
- [x] 新增第三条 cleanup 测试后，最终 `npm test`：222 / 222 通过
- [x] 门面 31 个运行时导出的精确集合测试通过
- [x] `detectPage` 三个异常分支均精确恢复 raw stdio writer，cleanup reject 测试通过
- [x] `detectPage` 主流程完整（代码审查 + 列表/搜索 smoke）
- [x] `submitInputs` / `retrySearchWithEnter` / manual submit 路径存在且调用关系与基线一致
- [x] `handleLoginInterventionIfNeeded` + `DetectionLoginRequiredError` 行为与基线一致
- [x] candidates：legacy 与 protected-smart 分支仍在；本轮 smoke 实际执行 legacy 路径
- [x] `page-detector*`：18 files / 64 unique edges / 0 cycles
- [x] `engine-host` 无 `any`；ExtraData `total` 语义正确；必需 runtime 方法不会静默 no-op
- [x] captcha / proxy handler 缺失不得假报成功，workflow 控制转发测试通过
- [x] 未发现「逻辑复制两份」或「门面残留死代码」
- [x] tracked `git diff --check` 通过，所有 TS / 测试文件无尾随空白
- [x] 本地 `detect` smoke：公开列表页 `exit 0` / `ok: true`，10 items / 4 fields
- [x] 本地 `detect` smoke：`q=orion` 搜索页 `exit 0` / `ok: true`，searchPlan 与结果页正确

---

## 12. 快速文件索引（给 reviewer 跳转）

| 想查… | 打开… |
|-------|--------|
| 主流程 | `src/runtime/detector/page-detector.ts` → `detectPage` |
| 浏览器启动/关闭 | `page-detector-host.ts` |
| 多标签谁被选中 | `page-detector-page-scoring.ts` |
| 登录弹窗 / 会话 | `page-detector-login.ts` |
| 搜索怎么提交 | `page-detector-search-flow.ts`、`page-detector-search.ts` |
| 列表候选怎么来的 | `page-detector-candidates.ts`、`page-detector-candidate-strategies.ts` |
| 字段名怎么洗的 | `page-detector-fields.ts` |
| 翻页怎么判的 | `page-detector-pagination.ts`、`page-detector-pagination-ui.ts` |
| 页内高亮脚本 | `page-detector-browser-overlays.ts`、`page-detector-overlay.ts` |
| 运行时 agent 类型 | `src/runtime/engine-host.ts` |
| 测试 | `test/detector.test.mjs`（主）、`test/cli-contract.test.mjs` 等 |

---

## 13. 变更作者说明（给审查人）

- 性质：以检测行为保持为主的拆分重构，并包含 §4.2 E 明确披露的 cleanup 安全修复；不是 feature。
- 验证：最终 typecheck + build + 全量测试 222 / 222 通过；detector 聚焦测试 128 / 128 通过；engine CfT 147 + legacy detector 的列表/搜索真实浏览器 smoke 均通过。
- 浏览器要求：smoke 应使用支持 `--load-extension` 的 Chrome for Testing / engine browser；本环境 branded Chrome 150 的 extension 注册失败不是 detector 回归。
- 提交：工作区仍为 dirty；是否合入由仓库负责人决定。
- 疑问优先对：
  1. 某段逻辑搬家后调用顺序是否变化
  2. testing export 是否遗漏
  3. `engine-host` workflow 事件 narrowing 是否过严，以及必需方法是否保持失败语义

---

## 附录 A — 工作区 `git status` 形态（撰写时）

```
 M src/runtime/detector/page-detector.ts
 M src/runtime/engine-host.ts
 M test/cli-contract.test.mjs
 M test/detector.test.mjs
?? docs/PAGE_DETECTOR_REFACTOR_REVIEW.md
?? src/runtime/detector/page-detector-browser-overlays.ts
?? src/runtime/detector/page-detector-candidate-strategies.ts
?? src/runtime/detector/page-detector-candidates.ts
?? src/runtime/detector/page-detector-fields.ts
?? src/runtime/detector/page-detector-host.ts
?? src/runtime/detector/page-detector-login.ts
?? src/runtime/detector/page-detector-manual-ui.ts
?? src/runtime/detector/page-detector-overlay.ts
?? src/runtime/detector/page-detector-page-scoring.ts
?? src/runtime/detector/page-detector-pagination-ui.ts
?? src/runtime/detector/page-detector-pagination.ts
?? src/runtime/detector/page-detector-popup.ts
?? src/runtime/detector/page-detector-scroll.ts
?? src/runtime/detector/page-detector-search-flow.ts
?? src/runtime/detector/page-detector-search.ts
?? src/runtime/detector/page-detector-shared.ts
?? src/runtime/detector/page-detector-utils.ts
```

## 附录 B — 体量对照

| 指标 | 基线 (HEAD) | 工作区 |
|------|-------------|--------|
| `page-detector.ts` 行数 | ~11 827 | 408 |
| detector 领域拆分文件数 | 1 巨石为主 | 18 个 `page-detector*` |
| `engine-host.ts` 中 `any` | 存在 | 0 |
| tracked 修改文件 | 0 | 4（2 个实现 + 2 个测试） |
| 相关 untracked 文件 | 0 | 18（17 个代码模块 + 1 个文档） |
| 自动化验证 | 基线既有测试 | 222 / 222 pass（含 typecheck + build）；detector 聚焦 128 / 128 |
| 真实浏览器 smoke | 无本轮记录 | 列表页 + `q=orion` 搜索页均通过（engine CfT 147 / legacy detector） |

---

*文档结束。如审查中发现行为回归，请优先标注「基线函数名 → 新文件路径」与失败测试名，便于定点修复。*
