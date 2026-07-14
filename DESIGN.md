# Design

## Source of truth

- Status: Active draft
- Last refreshed: 2026-07-14
- Primary product surfaces: 登录页、工作区壳层、文件浏览器、编辑器、AI 对话、Git、Agent Board、终端和设置
- Evidence reviewed:
  - `frontend/src/App.tsx`：三栏工作区、顶部操作栏、面板开关、Focus Mode 和响应式布局
  - `frontend/src/App.css`：现有浅色/深色 token、间距、面板和弹层样式
  - `frontend/src/components/ChatPanel.tsx`：Ask/Code/Review/Plan 模式、任务状态、工具调用和输入区
  - `frontend/src/components/GitPanel.tsx`、`AgentBoard.tsx`、`WorkspaceWelcome.tsx`、`CommandPalette.tsx`
  - `docs/screenshots/ide.png`、`docs/screenshots/login.png`
- 产品判断：功能骨架已经齐全，下一阶段重点是视觉层级、任务流连贯性和信息密度控制，而不是继续堆叠入口。

## Visual audit

- Observed: 当前工作区已经具备三栏布局、品牌标识、命令入口、AI 模式、Git/Agent/终端面板和深浅色主题。
- Observed: 顶部栏、左侧资源区和右侧 AI 区同时承载较多图标与状态，主次关系不够明显。
- Observed: 空工作区欢迎页视觉中心明确，但进入真实任务后，AI 任务标题、运行阶段、变更摘要和下一步动作没有形成同一条稳定的视觉主线。
- Observed: AI 面板已经有上下文、MCP、Memory/Skills 和运行历史状态，但多数状态仍以细小胶囊呈现，重要程度不足。
- Inference: “高级感”不应来自更多渐变或装饰，而应来自更克制的表面层级、稳定的任务结构、清晰的状态语义和更少但更强的操作入口。
- Inference: CrownForge 应从“IDE 三栏布局”进一步升级为“Agent Workbench”：编辑器是工作画布，任务是主线，面板是可调度的上下文工具。

## Frontend redesign direction

- Working name: **CrownForge Workbench**
- Visual keywords: calm, dense, precise, warm-metal accent, studio-grade, trustworthy.
- Core composition:
  - **Workspace Header**：品牌、当前工作区、当前任务、全局搜索/命令入口和面板调度。
  - **Activity Rail**：Explorer、Changes、Tasks、Agents、Terminal、Knowledge 等低噪声图标入口，统一激活态和计数。
  - **Workbench Canvas**：编辑器或 Diff 为视觉主角，减少无意义背景和卡片包围。
  - **Task Dock**：AI 任务标题、模式、运行阶段、上下文、变更摘要、验证结果和 Composer。
  - **Status Bar**：连接、分支、变更、光标和后台任务等低优先级信息。
- Interaction rule: 任何任务状态都要回答“现在做什么、做到哪一步、用户下一步能做什么”。
- Surface rule: 普通面板使用低对比度表面和细边框；只有当前任务、主按钮和关键警告使用高对比度强调。

## Advanced visual system

- Color roles:
  - Ink/background：深色主题以蓝黑和石墨灰为基础，浅色主题以冷白和雾灰为基础。
  - Crown accent：金色仅用于品牌、完成、关键里程碑和少量高价值动作。
  - Forge accent：青色用于 Agent/工具/流式运行等动态状态。
  - Action accent：蓝色用于焦点、链接、主按钮和当前选择。
  - Status colors：成功、警告、错误只表达状态，不用于大面积装饰。
- Typography:
  - 任务标题 20–24px；面板标题 12–14px；状态和元信息 10–12px。
  - 用户内容和 AI 结论使用舒适行高；工具日志、路径、Token 和运行指标使用等宽字体。
  - 减少全大写标签，使用短词和动词提高扫描速度。
- Layout rhythm:
  - 采用 4px 基础单位，主间距 8/12/16/24px。
  - 工作区边界、面板头部、输入区和状态栏使用固定节奏，不在局部随意增加高度。
  - 面板宽度优先保证任务内容和编辑器可读性，不以展示更多信息为目标。
- Shape/elevation:
  - 编辑器、Diff 和代码区保持平直；面板使用 10–14px 轻圆角；弹层使用单层阴影。
  - 取消连续嵌套卡片，改用“标题 + 分隔线 + 内容”的工作台结构。
- Motion:
  - 只保留面板进出、运行状态、流式输出和成功反馈动画。
  - 动画 120–220ms，可被打断，并完整遵守 `prefers-reduced-motion`。

## Revised information hierarchy

1. 当前任务：标题、模式、运行/等待/完成状态。
2. 当前动作：Agent 正在做什么、是否需要用户输入、停止/继续/重试入口。
3. 结果证据：变更文件、Diff、测试、Token/上下文和 MCP 工具状态。
4. 辅助信息：完整工具日志、运行历史、Memory/Skills、配置和原始错误。

The default view should show levels 1–3. Level 4 uses disclosure, drawers, or the Command Palette.

## Redesign component contract

- `WorkspaceHeader`: consolidate global actions and expose the active task without competing with the editor.
- `ActivityRail`: replace scattered panel icons with one predictable navigation surface and badge semantics.
- `TaskHeader`: unify Ask/Code/Review/Plan, run status, stop/resume/retry, and current workspace context.
- `TaskTimeline`: show the current phase and recent evidence; collapse raw tool calls by default.
- `ContextStrip`: show model capacity, context budget, MCP health, Memory/Skills and transcript recovery as readable status blocks rather than tiny badges.
- `ChangeSummary`: one reusable surface for changed files, review findings, tests and next actions.
- `Composer`: make mode, current file/selection, steering, attachments and send/stop state one coherent control group.
- `PanelShell`: standardize title, close, refresh, empty, loading and error states across Git, Agent, Team, Terminal, Settings and Knowledge.
- `KnowledgeCenter`: combine Memory and Skills management with search, scope, preview and recent usage while preserving the current admin boundary.

## Redesign phases and acceptance criteria

### Phase 0 — Token and shell foundation

- Rework CSS tokens into explicit roles for surface, border, text, accent, status and focus.
- Reduce top-bar control competition and establish a consistent activity rail.
- Acceptance: no feature removal; light/dark themes preserve contrast; all existing entry points remain reachable.

### Phase 1 — Task-first AI panel

- Rebuild the Chat header and Composer around TaskHeader, TaskTimeline and ContextStrip.
- Put conclusion, current phase, pending decision and next action above raw tool details.
- Acceptance: a user can identify task mode, state, current action and next available action within three seconds.

### Phase 2 — Editor and change canvas

- Make editor/Diff the visual center; simplify tab, breadcrumb, Git and review surfaces.
- Standardize ChangeSummary and make file/line navigation a first-class action.
- Acceptance: AI result → changed file → Diff → editor takes at most two deliberate actions.

### Phase 3 — Knowledge, Agent and settings surfaces

- Apply PanelShell to Agent Board, Team, Terminal, Settings, Memory and Skills.
- Turn MCP/Memory/Skills states into readable, actionable status blocks with clear ownership.
- Acceptance: loading, empty, error, disabled and offline states are consistent across all panels.

### Phase 4 — Responsive and visual regression

- Validate 1440px, 1280px, 1024px and 768px layouts in both themes.
- Add screenshot baselines for login, empty workspace, active task, running task, review, settings and narrow-screen drawers.
- Acceptance: no overflow, no unreachable controls, keyboard focus remains visible, and reduced-motion mode is usable.

## Brand

- Product name: CrownForge
- Underlying agent: Rolex Agent
- Personality: 安静、专业、可信、面向开发者；接近 Codex 的“工作台”而不是营销型聊天产品
- Trust signals: 清晰的运行状态、变更范围、工具调用过程、可恢复操作、明确的错误和空状态
- Logo direction: 深色工作台底、金色皇冠锻造符号、青色火花；在浅色和深色主题中保持清晰识别
- Avoid: 过度渐变、强装饰性卡片、无意义的动画、过多彩色徽章、把 AI 输出伪装成人类确认过的结果

## Product goals

- Goals:
  - 让用户一眼知道当前工作区、当前任务、AI 是否运行以及哪些文件发生了变化
  - 让“看代码 → 提问/执行 → 审阅变更 → 继续修改”的路径连续且低打扰
  - 用稳定的视觉语言承载 Ask、Code、Review、Plan 和多 Agent 协作
  - 保持桌面端高效率，同时让窄屏下的面板切换可用
- Non-goals:
  - 本阶段不修改认证、权限、命令执行边界或其他安全实现
  - 不为了视觉重构引入新的 UI 框架或第三方设计系统
  - 不把所有面板同时展示，避免工作区变成信息仪表盘
- Success signals:
  - 用户无需寻找即可定位工作区、模式、运行状态和变更入口
  - 常用操作可通过鼠标和键盘完成，且操作后有明确反馈
  - 关键页面在浅色/深色、空数据、加载、错误和窄屏状态下保持可理解

## Personas and jobs

- Primary personas:
  - 独立开发者：快速打开项目、让 AI 修改代码并检查 Diff
  - 团队开发者：观察 Agent、审阅变更、保留人工决策权
  - 内网/私有化部署用户：在稳定的浏览器工作台中使用本地或兼容 API 模型
- User jobs:
  - 找到文件并理解当前上下文
  - 让 AI 解释、规划、修改或审阅代码
  - 判断 AI 做了什么、是否成功、是否需要继续指导
  - 在多个任务面板之间切换而不丢失编辑上下文
- Key contexts of use: 大屏桌面开发、远程服务器浏览器、网络较慢或模型响应较慢的环境

## Information architecture

- Primary navigation:
  - 顶部工作区栏：品牌、工作区/快速打开、命令面板、全文搜索、全局面板开关
  - 左侧上下文栏：Explorer、Git、Agent/Team 等工作区资料
  - 中央主区：编辑器、Diff 或欢迎页
  - 右侧协作栏：AI 对话和任务状态
  - 底部辅助栏：终端、连接状态、文件语言和光标信息
- Core routes/screens:
  - Login
  - Empty workspace / Workspace welcome
  - Active editor workspace
  - Git changes and file Diff
  - AI task conversation
  - Agent Board / Team panel
  - Settings and plugin management
- Content hierarchy:
  1. 当前任务和当前文件
  2. AI 运行状态、需要用户决策的动作和变更摘要
  3. 工具调用细节、历史信息和辅助设置

## Design principles

- Focus first: 中央编辑区是默认主角，任何辅助面板都应可隐藏、折叠或抽屉化。
- State over decoration: 用状态、进度、变更数量和明确文案传达信息，不依赖装饰性卡片。
- Progressive disclosure: 先显示结论和下一步，工具调用、Diff 详情和 Agent 细节按需展开。
- Reversible by default: AI 操作、面板切换和上下文变更都应有清晰的回退或重新打开路径。
- Codex-like calm: 使用克制的中性色、单一主强调色和紧凑但可读的开发者密度。
- Tradeoffs: 优先桌面高效率；窄屏保证核心任务可用，不追求移动端完整 IDE 体验。

## Visual language

- Color:
  - 延续现有浅色/深色 token 和蓝色主强调色
  - 主内容使用中性色；蓝色仅用于当前状态、主操作、链接和焦点
  - 成功/警告/错误只表达状态，不作为大面积装饰
- Typography:
  - UI 使用现有系统无衬线字体；代码和路径使用等宽字体
  - 页面标题、面板标题、辅助标签建立明确的三级层级
  - 避免全大写长文案，面板标题保留短而可扫描的词组
- Spacing/layout rhythm:
  - 以 4px 为基础单位，常用间距 8/12/16/24px
  - 保留当前可拖拽侧栏，但为面板设置合理最小/最大宽度
  - 统一标题栏、标签栏、状态栏高度，减少局部自定义高度
- Shape/radius/elevation:
  - 面板和输入框使用轻微圆角；代码区保持平直、低干扰
  - 弹层使用一层明确阴影和遮罩，普通面板不使用重阴影
- Motion:
  - 仅用于面板打开、状态变化、流式输出和成功反馈
  - 动画短、可打断，并尊重 `prefers-reduced-motion`
- Imagery/iconography:
  - 使用 CrownForge 品牌 SVG 标记和 Lucide 图标；图标必须配合 tooltip 或可见文字
  - 不新增营销插画；欢迎页可以使用品牌标记和轻量几何图形

## Components

- Existing components to reuse:
  - `Sidebar`、`TabBar`、`ChatPanel`、`GitPanel`、`AgentBoard`、`TeamPanel`、`Terminal`
  - `CommandPalette`、`WorkspaceSearchPanel`、`WorkspaceWelcome`、`SettingsModal`
  - `BrandMark`、现有 `sidebar-action-btn`、状态徽章、弹层和 CSS token
- New/changed components:
  - `WorkspaceHeader`：从 `App.tsx` 中抽出顶部工作区栏，统一命令、搜索和面板入口
  - `TaskHeader`：统一 AI 模式、任务标题、运行状态、停止/重试/继续操作
  - `ChangeSummary`：统一变更文件、Diff、Review 结果和下一步操作
  - `PanelShell`：统一面板标题、工具栏、空状态、错误状态和关闭行为
- Variants and states:
  - default / hover / active / disabled / loading / error / empty / success
  - task: idle / running / waiting-for-input / completed / failed / stopped
  - panel: docked / collapsed / drawer / modal
- Token/component ownership:
  - 全局颜色、字号、间距、圆角、阴影由 `frontend/src/App.css` token 统一维护
  - 组件只消费 token，不在局部重复定义品牌色和状态色

## Accessibility

- Target standard: 以 WCAG 2.1 AA 的可操作性和可读性为目标
- Keyboard/focus behavior:
  - 命令面板、搜索、Diff、设置和抽屉支持 Esc 关闭、Tab 顺序和焦点回收
  - 所有仅图标按钮提供可读 tooltip/`aria-label`
  - 当前模式、当前面板和运行状态提供可感知的 `aria-current`/`aria-live`
- Contrast/readability: 正文、代码、禁用态和状态色在浅色/深色主题中分别验证对比度
- Screen-reader semantics: 面板使用 landmark 和 heading 层级；流式 AI 内容避免每个 token 触发朗读
- Reduced motion and sensory considerations: 支持减少动态效果；不使用仅颜色表达的状态

## Responsive behavior

- Supported breakpoints/devices:
  - >= 1280px：三栏工作区，侧栏可拖拽
  - 800–1279px：主编辑区优先，辅助栏可折叠为抽屉
  - < 800px：单主区模式，Explorer、AI、Git、Agent 和终端通过抽屉切换
- Layout adaptations:
  - 保证编辑器和 AI 输入区有最小可用宽度
  - 顶部操作从文字按钮收缩为图标按钮，并保留 tooltip
  - Diff、设置和命令面板使用接近全屏的窄屏布局
- Touch/hover differences: 触屏目标不小于 40px；不能只依赖 hover 展示关键操作

## Interaction states

- Loading: 显示局部 skeleton 或明确的“正在连接/加载/运行”状态，保留已有内容
- Empty: 欢迎页、无变更、无 Agent、无搜索结果分别给出解释和下一步操作
- Error: 错误靠近发生位置展示，说明可执行的恢复动作；不只显示通用失败提示
- Success: 保存、复制、审阅完成和任务完成使用短时 toast/状态标记，并保留结果入口
- Disabled: 说明禁用原因，避免只降低透明度
- Offline/slow network: 显示连接状态、重试和停止操作；流式任务结束后保留已有输出

## Content voice

- Tone: 简洁、直接、专业、可执行
- Terminology: 统一使用“工作区、任务、变更、审阅、运行中、等待输入、已完成、失败”
- Microcopy rules:
  - 按钮使用动词，如“打开 Diff”“继续任务”“重试”“停止运行”
  - 状态文案说明发生了什么和下一步能做什么
  - AI 结果优先显示结论、风险和操作，不用泛化的成功套话

## Implementation constraints

- Framework/styling system: React + TypeScript + Vite；沿用现有 CSS token 和组件模式
- Design-token constraints: 不新增 UI 框架；优先扩展 `frontend/src/App.css` 中的 token
- Performance constraints: 不让首屏加载完整 Monaco/非当前面板资源；弹层和面板继续按需加载
- Compatibility constraints: 保持 Docker 静态部署、现有中英文 i18n、桌面浏览器兼容和已有安全边界
- Test/screenshot expectations:
  - 每个阶段至少验证浅色/深色、空/加载/错误/运行中、1280px 和窄屏截图
  - 运行前端构建、后端构建、`git diff --check`，并进行一次真实浏览器冒烟测试

## Open questions

- [ ] 是否将“任务”作为默认主导航实体，还是继续以当前对话为主？影响顶部导航和历史列表
- [ ] 是否需要持久化用户的面板开关、宽度和主题偏好？影响本地设置和跨设备体验
- [ ] Review 结果是否需要专门的结构化发现列表与编辑器行号跳转？影响 Diff 和 AI 输出组件设计
- [ ] 是否需要提供预置主题/品牌色配置？影响 token 暴露范围和设置页复杂度

## Implementation roadmap

### Phase 1 — 视觉基础和工作区壳层

- 抽出 `WorkspaceHeader`、`PanelShell` 和 `TaskHeader`
- 统一 token、标题层级、按钮尺寸、面板头部和空/错误状态
- 优化顶部操作分组，减少并列图标造成的扫描负担
- 验收：不改变业务能力；浅色/深色主题视觉一致；所有现有入口仍可达

### Phase 2 — AI 任务工作流

- 重做 ChatPanel 的任务头、模式切换、运行中状态和 Composer
- 将工具调用折叠为“当前进度 + 可展开详情”，突出 AI 结论和待用户决策
- 增加上下文胶囊、当前文件/选区提示、停止/重试/继续的统一操作区
- 验收：用户能在 3 秒内判断任务模式、运行状态和下一步动作

### Phase 3 — 代码与变更审阅

- 优化 TabBar、文件路径层级、Git 变更列表和 Diff 弹层
- 将 Review 发现做成可扫描列表，支持严重级别、文件定位和回到编辑器
- 增加“变更摘要”作为 AI 回复与代码区之间的稳定桥梁
- 验收：从 AI 审阅结果跳到文件/行号不超过两步；无变更、未跟踪和冲突状态可理解

### Phase 4 — 协作面板与响应式

- 统一 Agent Board、Team、终端的面板框架和状态表达
- 在窄屏下改为抽屉导航，保证编辑器、AI 输入和任务状态仍然可用
- 补齐键盘焦点、Esc 关闭、tooltip、aria 和 reduced-motion 行为
- 验收：1280px、1024px、768px 三组视口完成冒烟与截图检查

### Phase 5 — 视觉回归与细节收口

- 建立关键页面截图基线：登录、空工作区、编辑中、AI 运行中、Review、Diff、窄屏
- 清理重复 CSS 和局部颜色，处理 Monaco chunk warning 可行的进一步拆分
- 完成构建、浏览器冒烟、主题和 i18n 回归
- 验收：无阻塞错误、无明显布局溢出、关键交互可用、现有安全边界未变
