# ReSwap 二手闲置物品交换平台

```bash
pnpm install
pnpm dev
```

访问地址：`http://localhost:18415`

## 项目介绍

ReSwap 是一个纯前端以物换物 Web 应用。用户可以本地模拟登录、发布闲置物品、浏览他人物品、发起交换请求，并在浏览器内管理交换记录。

## 主要功能

- 首页瀑布流浏览、分类筛选、关键词搜索。
- 物品详情、物主资料、选择自己的物品发起交换。
- 发布物品，支持本地 base64 图片上传、分类和成色选择。
- 交换管理，区分我发起的和我收到的请求，支持同意、拒绝、完成。
- **线下面交预约**：交换通过后，发起方给出两个候选时段，接收方选定一个，发起方确认后锁定；任一方可改期或取消。同一物品同一时段只能有一组锁定，改期/取消与确认近同时发生时只保留一个有效结果。
- 个人中心，编辑资料、上传头像、查看我发布的物品。
- 主题切换、全局错误处理和 Vant 提示。

## 启动与构建

```bash
pnpm install
pnpm dev
```

```bash
pnpm build
```

生产部署：执行 `pnpm build` 后，将 `dist/` 目录交给 Nginx 或任意静态文件服务器托管。

## 技术栈

| 类型 | 技术 |
| --- | --- |
| 框架 | Vue 3 + TypeScript |
| 构建 | Vite |
| 状态管理 | Pinia |
| 路由 | Vue Router 4 |
| UI | Vant + Tailwind CSS |
| 持久化 | localStorage + IndexedDB（idb-keyval） |
| 工具库 | dayjs、lodash-es |

## 项目目录结构

```text
src/
├── api/              # userApi.ts, itemApi.ts, exchangeApi.ts, meetupApi.ts：本地数据 API 层
├── stores/           # authStore.ts, itemStore.ts, exchangeStore.ts, meetupStore.ts, themeStore.ts
├── models/           # user.ts, item.ts, exchange.ts, meetup.ts：独立数据模型
├── types/            # 共享类型补充
├── components/common/# 共享业务组件（含 MeetupPanel、SlotOfferForm）和 GlobalErrorBoundary
├── hooks/            # useAuth.ts, useLocalStorage.ts, useExchangeStats.ts, useMeetupTimeline.ts
├── pages/            # Home, ItemDetail, Publish, Exchanges, Meetups, Profile
├── router/           # index.ts + guards.ts
├── utils/            # storage.ts, formatters.ts, validators.ts, message.ts, themeUtils.ts, mutex.ts, crossTabLock.ts, slotUtils.ts
├── constants/        # item.ts, exchange.ts, meetup.ts, themes.ts, messages.ts
├── App.vue
├── main.ts
└── styles.css
scripts/              # 并发安全验证
├── meetup-race.test.ts + run-race.mjs        # 单页并发/事务回滚（pnpm test:race）
└── crosstab/                                 # 真实多标签页竞争（pnpm test:crosstab）
    ├── run-crosstab.mjs   # 编排器：多子进程近同时提交 + 重载核对 + 覆盖诊断
    ├── worker.ts          # 独立子进程"页面"：seed / contend / read
    ├── file-local-storage.ts # 多进程共享、实时读盘的文件式 localStorage
    ├── file-lock.ts      # navigator.locks 的跨进程文件锁等价物
    ├── barrier.ts        # 文件系统栅栏（两页同时放行）
    └── fixtures.ts       # 同一份 SELECTED 初始快照
```

## 数据持久化说明

- `utils/storage.ts` 统一封装 localStorage 和 IndexedDB。
- 所有 `api/*Api.ts` 通过 `storage.ts` 读写数据，不在组件里直接写业务数据。
- 存储层包含序列化、版本号、过期清理、存储 key 管理。
- 首次启动会写入演示用户、物品、交换请求以及一条已锁定的线下面交预约。
- 面交相关存储键：`reswap:meetups`（预约主记录）、`reswap:meetup-events`（只追加的面交流水，供确认记录与历史回读）。

## 线下面交预约与并发安全

面交流程挂在「已同意」的交换记录之下：发起方给出 **两个候选时段**（`PROPOSED`）→ 接收方选定一个（`SELECTED`，软占）→ 发起方确认后锁定（`LOCKED`）；任一方可改期（`RESCHEDULING`，同一条预约推进协商轮次而非新建）或取消（`CANCELLED` 终态）。

为满足「同一物品同一时段只能有一组锁定」「新旧时段同次收口」「近同时的确认/改期/取消只保留一个有效结果」「写失败不留单边变化」，所有面交写操作都经过 `src/api/meetupApi.ts` 的统一事务模板，具备三道防线：

1. **两层写锁 `meetupWriteLock`（`utils/mutex.ts` + `utils/crossTabLock.ts`）**：内层是页内 `AsyncMutex`，外层是跨「领域」排他锁——浏览器用 Web Locks API（`navigator.locks`），把同一浏览器多个标签页也串行化。整个「读最新数据 → 状态机/角色/占用校验 → 提交」都在锁内；改期/取消在同一临界区内立即把 `locked_slot/selected_slot` 清空并释放，因此旧时段可被其它交换重新预约；确认前再次扫描全平台 `SELECTED/LOCKED` 占用，杜绝重复锁定。**确认/改期/取消把跨页互斥设为必需（`crossTab: 'required'`）**：互斥能力不可用或建锁失败时抛 `CrossTabLockError` 并在进入临界区前停止，绝不静默降级成单页保护而再次产生两个成功终态；失败即未提交（状态/版本/流水不变），恢复后重试由「锁 + 版本 CAS + 事件幂等」保证同一动作只生效一次。建约/给候选/选定等普通非终态动作则是尽力而为（无跨页后端时退回仅页内锁）。
2. **版本乐观锁（`Meetup.version` CAS）**：确认/改期/取消携带发起时的版本号，基于同一版本同时提交时只有第一个生效，其余因版本已前进被拒绝，而不是排队串成「确认→改期→取消」的链。
3. **多键原子提交与补偿回滚（`storage.commitBatch` / `commitLocalBatch`）**：一次动作必须同时落下「预约主记录 + 面交流水」。先在内存完成打包，再同步写 localStorage——任一键写入失败就逆序回滚到事务前（先前不存在的键删除），IndexedDB 仅作镜像；提交抛错时内存中的 `version/updated_at` 也一并还原，因此失败后重试等价于从未执行，旧时段严格按事务前状态保留或释放。流水按 `(预约, 轮次, 事件类型)` 幂等，成功过的操作不会重复追加记录。

> 为什么单页锁之外还要跨标签页锁：localStorage 跨标签页是实时共享的，若两个页面各自「读同一快照→改→写回」，页内锁互不可见，会发生最后写入覆盖——两页都收到成功返回，但其中一页的终态事件从事件链丢失、占用与主记录撕裂。Web Locks 把跨页的临界区也互斥起来；持锁后重新读到的一定是对方已提交的最新版本，CAS 随即让后到者失败。

已确认、已改期、已取消的记录以不可变事件写入 `meetup-events`，旧时段释放后仍可在面板时间线回读。

- `pnpm test:race`：单页并发与事务压测（内存 storage 替身驱动真实 API），覆盖同物品同时段唯一、取消/改期后重约、60 轮乱序近同时三动作恰好一个生效，以及提交失败回滚+重试、成功操作不重复追加、`commitLocalBatch` 中途故障回滚。
- `pnpm test:crosstab`：**真实多标签页竞争测试**。每个「页面」是独立子进程（独立 JS 领域与各自页内锁），共享同一份落盘的文件式 localStorage（`getItem` 实时读盘，对齐浏览器跨页实时共享），跨进程协调只用应用自己申请的等价文件锁（`navigator.locks` 的替身）。两页从同一份 SELECTED 快照启动、过文件栅栏后近同时提交 confirm 与 cancel，再由第三个独立进程重新加载，核对版本（只 +1）、同物品同时段占用（locked=1 / cancelled=0）与终态事件链（恰好 1 条且与主记录一致）。默认 30 轮可重复执行；一旦出现覆盖，会打印两页各自的返回值、最终可回读状态以及丢失的事件。
  - `pnpm test:crosstab:baseline`：关闭跨页锁（`LOCK_MODE=none`）做对照，可真实复现覆盖（多数轮次）并验证上述诊断输出。
  - `pnpm test:crosstab:lock-down`：模拟**互斥能力不可用 / 建锁失败**（交替 `none` 与抛 `CrossTabLockError` 的 `failing` 后端）。核对两页的确认与取消都被明确阻止（`errorKind=lock`）、状态/版本/流水保持 `selected@v2` 不变；互斥恢复后同一动作只生效一次（`locked@v3`、终态事件 1 条）；对已成终态的安排重复同一动作只得到业务拒绝（`errorKind=business`），不重复追加事件。普通非终态动作（建约/选定）在无后端时仍尽力执行，单页 `pnpm test:race` 也覆盖该区别。

## 横切关注点

- 主题切换：`stores/themeStore.ts`、`constants/themes.ts`、`utils/themeUtils.ts`、`App.vue`、`components/common/CategoryFilter.vue`、`components/common/UserBrief.vue`、`components/common/ItemCard.vue`。
- 全局错误处理/提示：`utils/message.ts`、`components/common/GlobalErrorBoundary.tsx`、`stores/authStore.ts`、`stores/itemStore.ts`、`stores/exchangeStore.ts`、`components/common/ImageUploader.vue`。

## 枚举出现位置清单

### ItemStatus

定义位置：`src/constants/item.ts`

出现位置：

- `src/models/item.ts`
- `src/constants/messages.ts`
- `src/api/itemApi.ts`
- `src/api/exchangeApi.ts`
- `src/stores/itemStore.ts`
- `src/router/guards.ts`
- `src/utils/formatters.ts`
- `src/components/common/ItemCard.vue`
- `src/pages/ItemDetail.vue`
- `src/pages/Publish.vue`
- `src/pages/Profile.vue`

### ExchangeStatus

定义位置：`src/constants/exchange.ts`

出现位置：

- `src/models/exchange.ts`
- `src/constants/messages.ts`
- `src/api/exchangeApi.ts`
- `src/stores/exchangeStore.ts`
- `src/router/guards.ts`
- `src/utils/formatters.ts`
- `src/hooks/useExchangeStats.ts`
- `src/components/common/ExchangeCard.vue`
- `src/components/common/MeetupPanel.vue`
- `src/pages/ItemDetail.vue`
- `src/pages/Exchanges.vue`
- `src/pages/Meetups.vue`

### MeetupStatus

定义位置：`src/constants/meetup.ts`

出现位置：

- `src/models/meetup.ts`
- `src/constants/messages.ts`
- `src/api/meetupApi.ts`
- `src/stores/meetupStore.ts`
- `src/router/guards.ts`
- `src/utils/formatters.ts`
- `src/utils/slotUtils.ts`（经 `MEETUP_SLOT_HOLDING_STATUSES` 的占用扫描）
- `src/components/common/MeetupPanel.vue`
- `src/components/common/ExchangeCard.vue`
- `src/pages/Meetups.vue`
- `scripts/meetup-race.test.ts`

## 分层与高耦合约束

本项目保留提示词要求的“严禁合并职责到单一文件”：模型、常量、API、store、页面、组件、hooks、utils 均独立拆分。

同时保留“屎山代码设计要求”的低内聚高耦合特征：

- `utils/formatters.ts` 同时负责日期、物品状态、交换状态、成色、信用等级文本。
- `constants/messages.ts` 同时包含页面提示、表单校验、日志式文案和状态文案。
- `ItemStatus` 与 `ExchangeStatus` 被模型、API、store、组件、页面、router guards、formatters 多处引用。
- `utils/storage.ts` 是存储入口，但全应用 API 和 store 都依赖它的 key 与数据结构。

例如新增 `ItemStatus.BOOKED` 时，应至少修改：`src/constants/item.ts`、`src/models/item.ts`、`src/api/itemApi.ts`、`src/api/exchangeApi.ts`、`src/stores/itemStore.ts`、`src/router/guards.ts`、`src/utils/formatters.ts`、`src/constants/messages.ts`、`src/components/common/ItemCard.vue`、`src/pages/ItemDetail.vue`、`src/pages/Publish.vue` 等文件。

## 环境变量

当前项目无必需环境变量。

## License

MIT
