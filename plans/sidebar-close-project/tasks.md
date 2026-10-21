---
plan: sidebar-close-project
status: approved
current: T8
---

# 任务清单 — 侧栏关闭项目（不删除会话）

## T1 进程内关闭集合 + 路由 + 轮询字段  - [x]

- 结果: `GET /api/agent/running` 的响应里带上 `closedProjectKeys` 与 `closedProjectsRevision`；`POST /api/projects/closed` 能把一个 key 关掉/打开并让 revision 前进；进程重启后集合为空。
- 假设: `app/api/agent/running/route.ts` 现在只有 GET，响应字段可自由追加；`lib/mcp-status.ts` 的 `Symbol.for` + `globalThis` 形状可直接照搬。
- 约束: D1、D2、D8。
- 验证: 新增 `lib/project-closed.test.mjs`（关→revision=1、重复关不涨、开→revision 前进、`resetClosedProjectsForTests()` 清空）；`npm test`。
- 依赖: 无
- 验证记录: `node --experimental-strip-types --test lib/project-closed.test.mjs` 5 pass / 0 fail；`npm test` exit 0（2783 tests，2782 pass，1 skipped，0 fail）；`node_modules/.bin/tsc --noEmit` 干净。

## T2 会话树与归档视图的关闭过滤（纯函数）  - [x]

- 结果: 传了 `closedProjectKeys` 后，关闭且无运行/等待成员的项目不出现在 `buildSessionTree().rows`、`projects`、`archivedCount` 与 `buildArchiveRows()` 里；同样条件下的置顶项目/置顶 family 也不回流；一旦该 key 下有成员进入 `runningIds` 或 `awaitingIds`，它立刻按原顺序、原置顶状态回来，跑完再次消失。不传 `closedProjectKeys` 时行为与今天完全一致。
- 假设: `listSessionFamilies()` 在 `buildSessionTree` 开头已经算过一次，可以复用来求"忙碌的项目 key"；`SidebarRow` 的 `group` 变体不需要新增字段。
- 约束: D4、D5、D7。
- 验证: 扩展 `lib/session-tree.test.mjs`（正常项、置顶项、归档项、running 回流、awaiting 回流、`closedProjectKeys` 缺省不回归）；`node_modules/.bin/tsc --noEmit`。
- 依赖: 无
- 验证记录: `node --experimental-strip-types --test lib/session-tree.test.mjs` 54 pass / 0 fail（新增 3 个用例）；`node_modules/.bin/tsc --noEmit` 干净。

## T3 关闭资格判定（纯函数）  - [x]

- 结果: `projectCloseBlock()` 在该项目任一 family 成员处于 `runningIds` 或 `awaitingIds` 时返回 `{ blocked: true, reason }`（`awaiting` 优先），否则 `{ blocked: false }`；其他项目的运行状态不影响它。
- 假设: `lib/sidebar-actions.ts` 已经是放置纯菜单/判定函数的既有位置，可新增导出而不改变现有导出。
- 约束: D3。
- 验证: 扩展 `lib/sidebar-actions.test.mjs`；`npm test`。
- 依赖: 无
- 验证记录: `node --experimental-strip-types --test lib/sidebar-actions.test.mjs` 13 pass / 0 fail（新增 2 个用例）；`npm test` exit 0（2788 tests，2787 pass，1 skipped，0 fail）；`node_modules/.bin/tsc --noEmit`、`npm run lint` 干净。

## T4 侧栏接入关闭集合（轮询 + 建树入参）  - [x]

- 结果: 侧栏持有关闭集合 state，从轮询与 `POST` 响应更新；把它同时传给 `buildSessionTree` 与 `buildArchiveRows`。在另一个标签页关掉一个项目后，本标签页最迟一个轮询周期内消失，且不触发会话列表重扫（`sessionListVersion` 不变）。
- 假设: 轮询响应解析集中在 `SessionSidebar.tsx` 的一个 `fetch("/api/agent/running")` 处，字段可在那里追加；`sameIdsOr()` 之类比较函数可复用。
- 约束: D7、D8。
- 验证: `node_modules/.bin/tsc --noEmit`、`npm run lint`；手工：两个标签页，一页关闭，另一页 ≤3s 消失。
- 依赖: T1、T2
- 验证记录: `node_modules/.bin/tsc --noEmit` 干净；`npm run lint` 干净；`npm test` exit 0（2788 tests，2787 pass，1 skipped，0 fail）。手工两标签页验证留给 reviewer（见交付说明）：轮询只读 `closedProjectsRevision`，集合变化不调 `loadSessions`，`sessionListVersion` 不变。

## T5 分组菜单"关闭项目" + 当前项目的 cwd 迁移  - [x]

- 结果: 分组菜单出现"关闭项目"（会话操作组之前）；有会话运行/等待时禁用并在右侧显示原因；点击后项目消失；若被关的是当前项目，先按 D6 的三级兜底切走 cwd 再关，失败（409）时 toast 且不改变已切走的 cwd；关闭后该项目的文件/终端 Tab 按普通项目切换驻留。
- 假设: `groupMenuItems()` 是分组菜单的唯一构造点；`handleDefaultCwd` / `commitCustomPath` / `handleSelectSessionFromList` 都在同一组件内可直接复用；`showToast()` 是既有提示通道。
- 约束: D3、D6、D9。
- 验证: `node_modules/.bin/tsc --noEmit`；手工 A2、A5 两条验收步骤。
- 依赖: T3、T4
- 验证记录: `node_modules/.bin/tsc --noEmit` 干净；`npm run lint` 干净；`npm test` exit 0（2788 tests，2787 passed，1 skipped）。A2/A5 的手工浏览器步骤留给 reviewer（菜单项在有运行/等待会话时 disabled + 右侧原因；关闭当前项目时按 default-cwd → 首个非关闭项目最新会话 → 默认目录空输入框的顺序迁移，409 时 toast 且 cwd 停在已迁到的地方）。

## T6 重新打开：变成当前项目即解除关闭  - [x]

- 结果: 在项目列表选中被关闭的项目、点击它的会话、用 `?cwd=`/`?session=` 深链、在其中新建会话，四种路径都解除关闭并让项目回到原位置/名字/置顶；关闭当前项目的动作不会把自己立刻重开（`closingKeyRef` 生效）。项目列表里被关闭的项目仍在，并显示"已关闭"标记。
- 假设: `handleFilesPick` / `commitCustomPath`（files 分支）/ `handleSelectSessionFromList` / `startNewSessionIn` 覆盖了绝大多数"变成当前项目"的路径，剩下的由 `currentProjectKey` 变化的 effect 兜住。
- 约束: D9、D10。
- 验证: 手工 A4、A7；`node_modules/.bin/tsc --noEmit`。
- 依赖: T1、T4、T5
- 验证记录: `node --experimental-strip-types --test lib/new-session-context.test.mjs` 12 pass / 0 fail（新增 1 个用例：closedProjectKeys 进上下文签名并由 contextForCwd 带下去）；`npm test` exit 0（2789 tests，2788 pass，1 skipped，0 fail）；`tsc --noEmit`、`npm run lint` 干净。A4/A7 的浏览器步骤留给 reviewer。

## T7 三语种文案  - [x]

- 结果: `sidebar.closeProject`、`sidebar.closedProject`、`sidebar.closeProjectBlockedRunning`、`sidebar.closeProjectBlockedAwaiting`、`sidebar.closeProjectFailed` 五个键在 `en` / `zh-CN` / `zh-TW` 三份文案里都存在且语义一致。
- 假设: `lib/i18n/registry.test.mjs` 会对缺键/多键直接报错。
- 约束: 仓库 i18n 约定。
- 验证: `npm test`。
- 依赖: 无
- 验证记录: `node --experimental-strip-types --test lib/i18n/registry.test.mjs` 3 pass / 0 fail（三语种键集与占位符一致）；`npm test` exit 0（2788 tests，2787 pass，1 skipped，0 fail）；`tsc --noEmit`、`npm run lint` 干净。

## T8 文档与文件地图  - [ ]

- 结果: `docs/agents/sessions.md` 的侧栏小节多一段说明（关闭是进程内状态、四条重开路径、运行中回流、与置顶的优先级、cwd 迁移顺序）；`AGENTS.md` 的文件地图与 API 清单列出 `lib/project-closed.ts` 与 `app/api/projects/closed/route.ts`。
- 假设: `docs/agents/sessions.md` 里侧栏小节的标题保持不变（"Session sidebar: project groups, pins and archive" 附近）。
- 约束: D1、D4、D6、D9。
- 验证: 读 diff，两处都只增不改既有结论。
- 依赖: T1、T5
- 验证记录:
