# Design

## Source of truth

- Status: Active draft
- Last refreshed: 2026-08-04
- Primary product surfaces: 营销首页、登录页、工作区壳层、文件浏览器、编辑器、AI 对话、Git、Problems、Run/Test、Checkpoints、Agent Board、终端和设置
- Evidence reviewed:
  - `../index.html`、`../login.html`、`../workbench.html`：本轮批准的全新视觉与交互基线
  - `../brand-spec.md`：现代极简、hairline 边框、单一蓝色强调色和任务状态优先的品牌规范
  - `frontend/src/App.tsx`：三栏工作区、顶部操作栏、面板开关、Focus Mode 和响应式布局
  - `frontend/src/App.css`：现有浅色/深色 token、间距、面板和弹层样式
  - `frontend/src/components/ChatPanel.tsx`：Ask/Code/Review/Plan 模式、任务状态、工具调用和输入区
  - `frontend/src/plugins/builtin/jsonPreviewPlugin.tsx`：JSON 文件的搜索、折叠、统计、复制和错误态可视化
  - `frontend/src/components/GitPanel.tsx`、`AgentBoard.tsx`、`WorkspaceWelcome.tsx`、`CommandPalette.tsx`
  - `frontend/src/components/CheckpointPanel.tsx`、`ProblemsPanel.tsx`、`RunCenterPanel.tsx`：IDE 工作流升级的三类新工作台表面
  - `backend/src/chat/checkpoints.ts`、`diagnostics/service.ts`、`run/service.ts`：可恢复、可定位、可验证的后端能力边界
  - `backend/src/auth/sessionManager.ts`、`routes/auth.ts`、`frontend/src/hooks/useAuth.ts`：登录会话、允许目录与工作区切换边界
  - `backend/src/agent/mcp.ts`、`permissionService.ts`、`toolApproval.ts`、`frontend/src/components/SettingsModal.tsx`：MCP 发现、启停与对话审批边界
  - `frontend/src/App.tsx`、`components/Editor.tsx`：并排文件对比与 Monaco 滚动状态
  - `frontend/src/editor/monacoSetup.ts`、`hooks/useEditorProblems.ts`、`backend/src/diagnostics/service.ts`：编辑器 marker、Problems 汇总与工作区诊断
  - `frontend/src/components/DebugPanel.tsx`、`RunCenterPanel.tsx`、`backend/src/debug/service.ts`：断点、调试会话、运行输出与调用栈
  - `backend/src/chat/worktrees.ts`、`routes/chat.ts`、`frontend/src/hooks/useAuth.ts`：Git worktree 与浏览器会话隔离边界
  - `docs/screenshots/ide.png`、`docs/screenshots/login.png`
  - `design/ai-chat-workbench.html`：用户在 2026-08-04 指定的新版 AI 工作台视觉与交互参考
  - `.omx/artifacts/visual-ralph/ai-chat-workbench/reference-updated.png`：2026-08-04 更新稿的编辑器首屏固定验收截图
  - `.omx/artifacts/visual-ralph/ai-chat-workbench/reference-updated-chat.png`：更新稿的对话状态固定验收截图
  - `.omx/artifacts/visual-ralph/ai-chat-workbench/reference-interactions.png`：2026-08-04 最新交互稿的编辑器与 AI 运行过程固定验收截图
- 产品判断：功能骨架已经齐全，下一阶段重点是视觉层级、任务流连贯性和信息密度控制，而不是继续堆叠入口。

## Approved 2026 redesign baseline

- Visual source of truth: `design/ai-chat-workbench.html` 是工作台最新且优先级最高的视觉参考；营销首页与登录页仍沿用仓库根目录的 `index.html`、`login.html`。默认桌面验收视口为 1440×900。
- Landing: 大留白、强排版层级、极少装饰；首屏突出“本地、离线、可控”，产品能力、任务主线和四种模式依次展开。
- Login: 左侧品牌/产品叙事与右侧登录卡并置；桌面端保留预览画布，窄屏收敛为单列登录流。
- Workbench: 56px 工作区 Header + 48px Activity Rail + Explorer + Editor Canvas + Task Dock + 22px Status Bar；编辑器永远是主视觉中心。
- Theme contract: 所有新增页面和工作台表面都必须消费同一组语义 token；亮色、暗色均为一等主题，主题偏好保存在本地并同步 Monaco。
- Interaction parity: 保留现有认证、文件、搜索、命令、Git、Agent、Team、终端、设置、AI 对话、面板拖拽和响应式抽屉能力。
- Visual acceptance: 首页、登录页、工作台在 1440×900 下与批准基线保持相同的信息层级、布局比例、密度和交互分组；允许使用仓库内真实数据替换原型假数据。

### Approved AI workbench reference — 2026-08-04

- Reference: `design/ai-chat-workbench.html`；最新交互截图：`.omx/artifacts/visual-ralph/ai-chat-workbench/reference-interactions.png`；对话固定截图：`.omx/artifacts/visual-ralph/ai-chat-workbench/reference-updated-chat.png`。
- Shell: 56px Activity Rail + 286px context sidebar + flexible task/editor canvas；编辑器状态可增加 400px AI 协作/活动栏，对话状态默认保持三栏并让中央画布获得剩余宽度。
- Default surface: 登录后默认进入文件/编辑器视图；编辑器 Header、Tabs、Breadcrumb、Monaco Canvas 形成纵向主线，当前文件、路径、连接状态和编辑器操作集中在 58px Header。
- Editor AI collaboration: 桌面编辑器默认打开右侧 AI 协作栏；当前文件路径与代码选择自动成为下一条指令的上下文，切换文件时同步更新；工作模式与管理员已配置模型在发送前可选择，运行期间锁定；“AI 协作 / 终端 / 变更”在编辑器 Header 内互斥调度。
- Agent run process: AI 协作栏以真实运行事件呈现当前步骤、状态、耗时与可展开详情；运行中“暂停”安全停止当前 run，停止或失败后“继续”从该 run 恢复，完成后“重新运行”复用上一条指令，不使用纯前端伪进度。
- Chat sidebar: 工作区身份置顶，“新建任务”作为第一主操作；搜索与按日期分组的任务历史形成稳定纵向层级，底部只保留紧凑上下文预算。
- Task canvas: 58px Task Header 展示任务标题、工作区状态、连接状态与“对话 / 变更”切换；消息正文最大宽度 800px 并居中，工具运行步骤内嵌在 AI 回复中而非散落为独立仪表盘。
- Composer: 固定在任务画布底部，最大宽度 800px；文本输入、上下文、命令、模型与发送/停止组成一个边界清晰的控制面，背景通过轻量渐隐与内容区分离。
- Activity detail: 编辑器默认呈现 AI 协作；显式打开变更后切换为“变更 / 检查 / 终端”运行详情。桌面为右侧 400px 固定栏，<=1180px 为覆盖抽屉，<=780px 与左侧栏共同服从单抽屉布局。
- Visual language: 使用 OKLCH 中性色、单一蓝色强调色、hairline 边框、10–16px 克制圆角；普通工作台表面无重阴影，仅 Composer、弹层与覆盖抽屉使用浮层阴影。
- Fidelity contract: 保留现有文件、Git、Agent、Team、Problems、Run/Test、Checkpoints、终端、设置和 AI 模式能力；新版参考决定布局比例、层级、密度、形状与交互分组，真实业务数据替换原型假数据。
- Reproduction: `python3 -m http.server 4174 --bind 127.0.0.1`（仓库根目录），访问 `/design/ai-chat-workbench.html`，视口 1440×900。
- Pass threshold: 实际应用截图与参考经 `visual-verdict` 评分达到 90；最终保留参考、实际截图、verdict JSON 和像素差异图。

## Visual audit

- Observed: 当前工作区已经具备三栏布局、品牌标识、命令入口、AI 模式、Git/Agent/终端面板和深浅色主题。
- Observed: 顶部栏、左侧资源区和右侧 AI 区同时承载较多图标与状态，主次关系不够明显。
- Observed: 现有全局字号偏向紧凑仪表盘密度，正文、面板标题和文件树在远程服务器浏览器中可读性不足。
- Observed: 资源管理器把文件树操作集中在一排小图标中，工作区路径与文件筛选能力不够突出，批量操作也缺少明确的模式反馈。
- Observed: 空工作区欢迎页视觉中心明确，但进入真实任务后，AI 任务标题、运行阶段、变更摘要和下一步动作没有形成同一条稳定的视觉主线。
- Observed: AI 面板已经有上下文、MCP、Memory/Skills 和运行历史状态，但多数状态仍以细小胶囊呈现，重要程度不足。
- Inference: “高级感”不应来自更多渐变或装饰，而应来自更克制的表面层级、稳定的任务结构、清晰的状态语义和更少但更强的操作入口。
- Inference: CrownForge 应从“IDE 三栏布局”进一步升级为“Agent Workbench”：编辑器是工作画布，任务是主线，面板是可调度的上下文工具。

## IDE workflow upgrade — 2026-07-24

- Safety and review: 每次 Code 任务在任何 Agent 工具执行前建立工作区 Checkpoint；恢复操作必须明确确认，并在完成后关闭失效编辑器状态、刷新文件树。直接写入 Git、Checkpoint、团队、Codex/OMX 元数据和密钥文件的工具调用必须被策略层拒绝。
- Problems and diagnostics: Monaco 实时 marker 与工作区 TypeScript/Ruff/Cargo 检查汇总到同一 Problems 表面；每条问题包含严重级别、来源、文件、行列，并可一步定位到编辑器。
- Run and test: 只发现项目声明的 npm、Cargo 和 Python 任务，不接受来自浏览器的任意命令；运行结果保留状态、耗时、输出与可导航失败位置。
- Navigation contract: Explorer、Git、Agent、Checkpoints、Problems、Run/Test 是 Activity Rail、Command Palette 和 Status Bar 共享的工作台入口；这些上下文面板互斥打开，避免压缩编辑器成为仪表盘。
- Interaction contract: 新面板复用 `PanelShell` 的标题、刷新、关闭、空、加载和错误状态；窄屏一次只展示一个抽屉，并通过标题栏紧凑命令入口保持所有面板可达；所有图标操作必须有本地化名称与可见焦点。
- First-stage scope: 第一阶段提供本地 Checkpoint 恢复、拒绝式安全策略、统一 Problems 和声明式 Run/Test 入口。

### JSON parser plugin contract — 2026-07-25

- Product surface: 现有内置 `JSON Visualizer` 升级为 `JSON Parser`，避免同一文件出现两个竞争性的树视图插件；搜索、统计、折叠和复制能力继续保留。
- Hierarchy editing: 用户可以在树中编辑基础值、重命名对象键、向对象或数组添加子节点、删除非根节点；对象新增与重命名必须阻止空键和重复键，数字输入必须经过有限数值校验。
- Safe write boundary: 插件不得直接写入文件系统。每次结构修改只通过受权限控制的编辑器内容回调生成格式化 JSON，复用现有 dirty tab、保存、远端版本冲突和团队只读角色策略。
- Permission model: 修改内容需要独立的 `editor.modify` 权限；只有声明该权限的预览渲染器可以收到写回能力，普通 `editor.preview` 插件保持只读。
- Reversibility: 插件内的结构操作提供撤销和重做；切换文件或检测到插件外部内容更新时清空本地历史，避免把一个文档的历史应用到另一个文档。
- Interaction and accessibility: 节点操作在 hover 与键盘 focus 时可见；编辑通过具备标题、说明、校验反馈和明确取消/确认动作的对话框完成；只读工作区显示原因并禁用所有修改入口。
- Acceptance: 在有效 JSON 中完成“添加子节点 → 编辑值 → 重命名键 → 删除节点 → 撤销/重做”后，源码编辑器内容与树视图一致且文件标记为未保存；无效 JSON 保持错误态，不提供破坏性修复捷径。

### Explorer copy and paste contract — 2026-07-25

- Source and destination: 文件或文件夹通过自身右键菜单进入单项资源管理器剪贴板；粘贴入口只出现在目标文件夹与工作区根目录的右键菜单中，目标语义始终明确。
- Clipboard feedback: Explorer 在剪贴板非空时显示紧凑状态条，标明已复制的项目并允许清除；切换工作区时必须清空剪贴板，避免跨工作区使用失效路径。
- Safe copy semantics: 粘贴只执行复制，不隐式移动或覆盖；目标中存在同名项目时返回明确冲突反馈，文件夹不得复制到自身或其后代目录。
- Permission and path boundary: viewer 团队角色不可复制或粘贴；服务端重新解析源与目标路径，并继续以工作区安全路径边界为最终权限依据。
- Completion feedback: 复制成功后刷新文件树、显示目标路径，并记录可读的团队活动；失败状态需区分同名冲突、自包含目标与一般复制失败。
- Acceptance: 用户可将文件和含嵌套内容的文件夹复制到另一个文件夹或工作区根目录；源项目保持不变，目标完整出现，重名、自包含、只读与越界操作均不会修改文件系统。

### Workspace context contract — 2026-07-27

- Session isolation: 每次账号密码登录都创建独立会话；工作目录、Team、Terminal、Agent 单例和审批状态不得在同用户名的多个浏览器会话之间共享。
- Workspace selection: Explorer 的当前工作区卡片与“打开文件夹”入口共同打开目录选择器；只允许浏览和选择 `users.json.allowedRoots` 内已经存在的目录，切换失败时弹层保留并在原位展示原因。
- Atomic context switch: 工作区切换成功后，打开文件、预览、选择、Explorer 剪贴板、团队上下文和旧 Git Diff 必须清空；文件树、对话上下文、终端、运行/调试入口与 Git 状态都从新目录重新建立。Git 面板在切换过程中不得继续显示旧仓库的分支或变更。
- Git scope: Git 状态以当前工作目录为请求边界；切换到另一个仓库立即重新加载其分支和变更，切换到非仓库目录显示明确空状态。状态和 Diff 中的文件路径始终相对当前工作目录，不能导航到工作区之外。
- Acceptance: 两个同名用户会话可选择不同目录且互不影响；选择目录后 Explorer 首次刷新即展示新树，已打开 Git 面板先清空旧状态再展示新仓库；允许目录校验失败时不改变当前会话。

### Local registration approval contract — 2026-07-27

- Entry and states: 登录卡片内使用“登录 / 注册”分段切换，不增加独立路由。注册表单只收用户名、密码和确认密码；提交成功后回到登录态，并明确提示“管理员审核通过后可登录”。重复用户名、弱密码、两次密码不一致和网络失败必须在卡片内原位反馈。
- Offline persistence: 注册申请与现有用户配置共同保存在本地 `users.json`，重启后仍可审核；管理 API 只返回用户名和申请时间，不返回待审核密码。
- Approval boundary: 只有已登录管理员可以查看、批准或拒绝注册申请。批准后创建普通用户，默认工作区为第一个 `allowedRoots` 下的同名目录；注册申请不能请求管理员权限或自定义越界目录。
- Admin review: 管理员设置的“用户管理”卡片先展示待审核申请及数量，再展示手动创建用户表单和现有用户列表；审核中禁用重复操作，批准或拒绝后立即刷新列表并显示成功反馈，无申请时展示明确空状态。
- Acceptance: 未审核用户不能登录；申请在服务重启后仍存在；批准后原密码可立即登录且工作区位于允许根目录；拒绝后申请消失且账号不可登录；用户名冲突不会覆盖现有账号或已有申请。

### Phase 2 workflow contract

- Tool approval: `write_file`、`edit_file` 和可执行 shell 命令在执行前暂停 Agent，并展示工具、参数摘要、风险等级和影响范围。用户可以“仅本次允许”或拒绝；文件写入可以在当前 WebSocket 会话内按工具与目录放行，shell 命令永远逐次审批。被安全策略硬拦截的命令不可通过审批绕过，断线、停止任务和超时都视为拒绝。
- Background diagnostics: 工作区诊断从一次性按钮升级为可启动、可停止、可观察的后台会话；文件变化经过防抖后自动刷新 TypeScript、Ruff 和 Cargo 结果。Problems 标题区显示 watching/running/idle/error 和最近完成时间，但后台服务不得抢占编辑器焦点或制造重复通知。该阶段实现“常驻诊断生命周期”，不把编译器轮询伪装成完整 LSP 协议。
- Cancellable tasks: Run/Test 采用异步子进程和任务记录；运行中必须显示状态、开始时间和实时输出，并提供 Stop。停止先发送 `SIGTERM`，短暂宽限后再终止进程组；历史记录区分 passed、failed、cancelled 和 timed_out，浏览器不能提交任意命令。
- Debug session runtimes: 调试工作台同时支持 Node.js JavaScript 与 Python 文件。JavaScript 继续复用 Node Inspector；Python 使用固定版本的 `debugpy` 作为 Debug Adapter Protocol（DAP）实现，并按 `initialize -> launch -> initialized -> setBreakpoints -> configurationDone` 顺序建立会话。两种运行时共享工作区相对路径、团队只读权限、输出上限和进程组终止边界；远程 attach 与子进程调试仍不在本阶段范围内。
- Paused-state inspection: 每次暂停都以当前线程和栈帧为上下文加载作用域，再通过运行时对象引用按需展开变量；Local、Global、Closure 和嵌套对象使用统一树形语义。切换栈帧必须同步刷新变量，恢复运行后立即废弃旧对象引用，不能继续展示上一暂停点的数据。Debug Console 在暂停时支持基于当前栈帧求值，并将表达式、结果和可操作错误与程序 stdout/stderr 明确区分。
- Stepping feedback: Continue、Step Over、Step Into 和 Step Out 由运行时的 resumed/continued 与 paused/stopped 事件驱动。单步命令发出后先清空失效的栈帧和变量，在下一次暂停时自动选择新栈顶、打开对应文件，并用独立于断点的当前执行行箭头和整行高亮反馈真实位置；不得依赖用户手动点击调用栈来确认是否前进。按钮在命令进行中禁用，快速的 running -> paused 变化也必须可观察且不能被轮询竞态覆盖。
- Python debug interaction: 打开 `.py` 或 `.pyw` 文件时自动填入调试目标并允许在当前行切换断点；调试状态必须明确标识 Python 运行时。`debugpy` 的 output、stopped、continued、exited 和 terminated 事件映射到现有状态与输出区，内部适配器日志不得混入用户程序输出；解释器或 `debugpy` 依赖缺失、目标越界、DAP 握手超时和不支持的扩展名必须显示可操作错误，不能表现为无反馈按钮。
- Navigation and state: Debug 与 Run/Test、Problems、Checkpoints 一样通过 Activity Rail 和 Command Palette 可达；运行、调试、诊断和审批都必须在窄屏抽屉中可操作，且关闭面板不终止后台任务。
- Phase 2 acceptance: 未经批准的副作用工具不执行；运行任务能在完成前取消且留下 cancelled 记录；修改源文件后诊断会话自动产生新一代结果；Node 与 Python 调试会话均可在断点暂停，展示局部变量和至少一层嵌套对象，单步后编辑器执行行与栈顶同步前进，切换栈帧会刷新变量，Debug Console 可在当前栈帧求值；所有新状态具备本地化名称、键盘焦点和错误恢复入口。

### Phase 3 review contract

- Stable change bridge: `ChangeSummary` 是 AI 结果、Git 变更和编辑器之间唯一的摘要表面；同一轮任务不重复渲染两套文件统计。摘要始终先回答结果状态、发现数量和变更范围，再按需展开文件与原始细节。
- Structured review findings: Review 模式采用可解析的严重级别、文件、行列和结论结构；critical/error/warning/info 使用固定语义，文件位置是可聚焦按钮，并可一步回到编辑器。无法定位的自然语言仍保留在回复正文，但不伪装成结构化发现。
- Change navigation: Git 变更按冲突、已跟踪和未跟踪分组；每行提供明确的“查看 Diff”和“打开文件”动作，Tab 对同名文件显示最短可辨识路径并支持方向键、Home/End 和关闭键。
- Diff surface: Git Diff 复用 Monaco 并排审阅画布，增加 added/modified/deleted/untracked/conflicted 状态、打开文件和复制补丁；原始 patch 收入可展开区域。新增文件以空基线比较，删除文件以空工作区版本比较，二进制或过大内容必须给出可理解的降级状态。
- Conflict continuity: Git 冲突与远端版本冲突保持各自的决策能力，但共享相同的状态术语、文件定位和退出行为；冲突不得仅依赖颜色或单字母状态表达。
- Phase 3 acceptance: AI Review 发现到文件行号最多一次操作，变更摘要到指定 Diff 最多一次操作；无变更、未跟踪、删除和冲突均有解释与下一步；桌面与窄屏可使用键盘完成 Tab、变更列表和 Diff 的主要动作。

### Agent recovery operations contract — 2026-07-28

- Placement: 会话 Fork 和运行回滚属于 Chat 历史上下文操作；Git worktree 与 workspace checkpoint 共同归入现有 Checkpoints/Recovery 抽屉，避免新增 Activity Rail 顶级入口。
- Conversation fork: 历史会话提供完整 Fork，消息节点提供“从此处 Fork”；成功后直接进入新会话，原会话保持不变。操作使用分支图标、可读 tooltip 和执行中禁用态。
- Conversation deletion: 任务侧栏和完整历史列表都提供低强调的删除入口，并在执行前明确说明“删除历史不会撤销工作区改动”。服务端拒绝删除仍有活跃运行的对话；删除当前对话后进入空白新对话状态，其他对话与工作区文件保持不变。删除失败必须留在原列表并显示可恢复错误。
- Run revert: 仅 Code 模式的已结束根运行展示回滚入口。执行前必须说明将恢复运行前工作区、未保存编辑器状态会失效；成功后关闭旧编辑器状态并刷新文件树。
- Worktree management: Recovery 抽屉使用“快照 / Worktrees”分段切换；Worktree 表面支持基于名称和 revision 创建、打开隔离工作区、列出路径/分支/HEAD，以及确认后移除。非 Git 工作区显示靠近操作区的可恢复错误。
- Visual and interaction: 复用 `PanelShell`、`dialog-btn`、细边框卡片、状态徽章和 8/12px 间距；危险操作使用语义化 danger 状态但不铺大面积红色。所有动作具备 loading、disabled、empty、error 和成功 toast。
- Responsive/accessibility: 操作留在现有 Chat/Recovery 抽屉内，在窄屏不新增并列面板；图标按钮提供 `aria-label`/tooltip，分段控件使用 tab 语义，异步错误使用 `role="alert"`。
- Acceptance: 用户可在两步内完成完整会话 Fork、消息点 Fork、删除已结束对话、运行回滚或创建 Worktree；任何删除、恢复或移除操作均经过确认，成功后界面状态与持久化数据一致。

### MCP, approval, and compare interaction contract — 2026-07-29

- MCP discovery: 保存 MCP 配置必须立即失效旧发现缓存，下一轮工具发现必须只使用已保存配置；连接成功但工具未注入模型的状态不可被呈现为“可用”。可写工作区中的 Ask、Code、Review、Plan 对话都可发现已启用 MCP 工具，最终可调用范围继续由 Agent profile 与审批策略收窄。
- MCP activation: 每个已保存的远程或 stdio MCP 服务在连接结果列表中显示“已启用 / 已禁用”状态并提供单步切换；禁用服务不建立连接、不暴露工具，重新启用后立即刷新发现结果。高级服务仍由原配置对象持有 `disabled`，普通 URL 服务复用 `disabledUrls`，避免引入第二套状态源。
- Conversation approval: 审批区提供“一键批准本次对话”。动作只覆盖当前 WebSocket 生命周期内、同一 conversation id 的当前与后续软审批；硬策略拦截、只读角色、停止任务和断线仍不可绕过。切换到其他对话不得继承该授权。
- Approval continuity: 待审批操作必须出现在用户当前使用的 AI 表面。完整对话页继续在 Composer 上方显示审批区；文件编辑视图的 `EditorAssistantPanel` 同样在消息区与 Composer 之间显示同一审批队列、单次/会话批准和拒绝操作。编辑视图收到新审批时自动打开协作栏并退出运行详情替代面板，避免被阻塞的任务没有可见下一步。两个表面复用同一状态源与响应函数，切换视图不得丢失、复制或自动批准请求。
- Compare scrolling: 并排文件对比默认启用同步滚动，并提供可见开关。两个 Monaco 编辑器按各自可滚动范围映射纵向和横向位置，避免不同文件长度导致单边提前触底；程序化镜像滚动不得形成反馈循环，关闭同步后两侧恢复独立滚动。
- Accessibility and feedback: MCP 启停与同步滚动按钮必须暴露 pressed/disabled 语义和本地化名称；批量批准只在存在待审批项时出现，文案明确授权边界；保存、刷新、启停失败均在原设置/对话表面反馈。
- Acceptance: 保存并测试通过的 MCP 在下一轮任一对话模式中进入模型工具列表；任一服务可启停且状态重载后保持；审批请求在完整对话页和编辑器右侧协作栏均可处理；批准当前对话后同对话后续软审批不再逐项暂停而其他对话仍需审批；文件对比两侧可同步滚动并可随时关闭。

### Editor diagnostics, debug, and isolated vibe windows — 2026-07-30

- Live diagnostics: JavaScript/TypeScript 由 Monaco 的语法与语义诊断驱动，必须识别语法错误、类型问题和未知标识符；Python 文档通过防抖后的 Ruff 标准输入检查覆盖未保存内容。两类结果统一写入 Monaco markers，并由 Problems 面板汇总，旧请求结果不得覆盖较新的编辑内容。
- Diagnostic feedback: 错误与警告使用 VS Code 类似的波浪线、overview ruler 和 Problems 条目，条目包含来源、消息、文件与行列并支持一步跳转。只读文件仍可检查；诊断失败显示为可恢复状态，不能阻断编辑或保存。
- Breakpoint interaction: 可调试文件在行号左侧 glyph margin 点击即可增删断点，断点按文件维护并显示红色圆点；编辑器与 Debug 面板共享同一份受控断点状态，避免面板按钮、行号点击和实际调试会话发生偏差。
- Run current file: 当前 `.js`、`.mjs`、`.cjs`、`.py` 或 `.pyw` 文件提供直接运行/调试入口；未保存内容先走既有保存与版本冲突流程，再启动对应 Node Inspector 或 debugpy 会话。断点、运行状态、继续/暂停/单步/停止、调用栈和程序输出使用同一 Debug 工作台展示。
- Output surface: 输出区采用控制台式等宽文本与明确的 running、paused、stopped、failed 状态；运行时输出和适配器错误分层呈现，失败信息保留可操作上下文。Run/Test 继续只执行项目声明任务，其历史与实时输出视觉语义和 Debug Console 保持一致。
- Isolated vibe windows: “新建隔离 Vibe 窗口”必须为当前 Git 工作区创建独立 worktree 和派生认证会话，再打开新的浏览器窗口。派生会话的 workspace 固定到该 worktree，不允许在该窗口切换回共享工作目录；每个窗口拥有独立 WebSocket、打开文件、终端、运行/调试和 Agent 单例。
- Credential and lifecycle boundary: 派生 token 不进入 URL，也不覆盖主窗口的 localStorage；只通过新窗口的瞬时 `window.name` 交接并落到该窗口 sessionStorage。创建失败关闭预开窗口并显示错误；隔离窗口的分支与路径继续由 Recovery/Worktrees 表面管理，用户可审阅、合并或移除，不做隐式合并。
- Acceptance: 输入尚未保存的错误代码即可看到行内提醒和 Problems 条目；点击 gutter 设置断点后运行当前 Node/Python 文件可暂停并在同一工作台查看调用栈与输出；同时打开两个隔离 Vibe 窗口修改同一原始文件时，修改分别落在不同 worktree/branch，主工作区和其他窗口文件均不被直接覆盖。

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
  - 任务标题 20–24px；面板标题 13–15px；正文和文件名 14px；状态和元信息不低于 11–12px。
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
- `Explorer`: keep the workspace identity visible, provide an inline tree filter, group primary creation actions, and make selection mode and item states legible without relying on tiny icon-only controls.
- `JsonPreview`: render valid JSON as a searchable, collapsible and permission-aware hierarchy editor with node statistics, reversible add/edit/rename/delete actions and copy actions; keep invalid JSON in a clear error state and preserve parity across light and dark themes.

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
  - 不绕过认证、团队只读角色、工作区路径约束或工具执行策略
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

- Explorer hierarchy:
  1. 当前工作区名称和路径
  2. 文件树筛选与主要创建操作
  3. 当前文件、展开层级和协作状态
  4. 上传、下载、批量删除等低频操作

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
  - 页面标题、面板标题、正文、文件名和辅助标签建立明确的三级层级，默认正文不低于 14px
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
  - `JsonPreview`：作为 `builtin.json-preview` 内置插件，为 JSON 文件提供树形预览、搜索、统计、展开/折叠、路径/值复制和格式错误反馈
  - `Editor comparison workspace`：从已打开标签中选择第二个文件，在同一画布内并排显示主编辑器与只读参考文件；窄屏改为上下分栏
  - `Explorer`：文件树默认仅展示最外层；根目录和文件夹右键菜单均提供上传入口，并允许将本地文件拖放到明确高亮的目标文件夹；文件和文件夹支持右键复制，并可在目标文件夹或工作区根目录右键粘贴
  - `Chat details region`：任务模式、上下文、历史、变更和运行摘要统一进入可收起区域；开始对话后自动收起，优先保留 AI 回复和输入区
  - `CheckpointPanel`：展示自动/手动工作区快照、范围元数据和显式恢复操作
  - `ProblemsPanel`：合并编辑器 marker 与项目诊断，按严重级别筛选并导航至源代码
  - `RunCenterPanel`：发现可信项目任务，展示运行状态、失败位置和完整输出
- Variants and states:
  - default / hover / active / disabled / loading / error / empty / success
  - task: idle / running / waiting-for-input / completed / failed / stopped
  - panel: docked / collapsed / drawer / modal
  - editor: standard / preview / split-preview / file-comparison
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
- [x] Review/诊断结果使用结构化 Problems 列表并支持编辑器行号跳转；Phase 3 将 AI Review 发现并入统一 `ChangeSummary`
- [x] Agent 工具审批采用文件写入按工具与路径的当前会话信任，shell 命令逐次审批；拒绝式安全策略不可绕过
- [x] Phase 2 采用常驻诊断生命周期与 Node Inspector 调试 MVP；完整 LSP/DAP 和跨语言调试矩阵留待后续
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

#### Phase 4 implementation contract

- `AgentBoard`、`TeamPanel`、`Terminal` 必须复用同一组面板头部、状态条和空/加载/错误状态语义；标题、连接状态、刷新和关闭操作的位置保持稳定。
- Agent 状态以“执行中 / 空闲 / 已停止”呈现，Team 状态同时说明连接、当前角色、在线人数和文件认领能力，终端状态区分连接中、已连接、离线、只读禁用，并提供可发现的重连入口。
- 1280px 保留桌面工作台的并排上下文；1024px 优先保证编辑器和 AI Composer 宽度，协作表面以单个右侧抽屉覆盖；768px 只允许一个工作区抽屉打开，终端改为全高抽屉而非压缩编辑器。
- 窄屏抽屉使用 `dialog` 语义并标注标题，打开后焦点进入面板，关闭或按 Escape 后焦点回到触发按钮；scrim 只在窄屏可交互，并关闭当前最上层抽屉。
- 所有图标按钮同时提供 tooltip 和 `aria-label`；异步状态使用 `aria-live`，错误使用 `role="alert"`，装饰性状态点对辅助技术隐藏。
- 动画仅用于抽屉进入、连接/执行状态和反馈，持续 120–220ms；`prefers-reduced-motion` 下取消位移、脉冲和光标闪烁，不影响状态识别。
- 验收证据包含 1280px、1024px、768px 三组视口截图，至少覆盖 Agent、Team、Terminal 三种协作表面，以及 Escape、焦点回归、无水平溢出和 reduced-motion 冒烟。

### Phase 5 — 视觉回归与细节收口

- 建立关键页面截图基线：登录、空工作区、编辑中、AI 运行中、Review、Diff、窄屏
- 清理重复 CSS 和局部颜色，处理 Monaco chunk warning 可行的进一步拆分
- 完成构建、浏览器冒烟、主题和 i18n 回归
- 验收：无阻塞错误、无明显布局溢出、关键交互可用、现有安全边界未变

#### Phase 5 implementation contract

- 截图基线存放在 `docs/screenshots/baseline/`，使用稳定的视口、主题、工作区和状态命名；基线索引必须说明可复现步骤、动态内容边界与最后验证日期。
- 至少覆盖登录、空工作区、编辑中、Review/Diff、Settings、AI 运行态和 768px 协作抽屉；无法由离线环境自然触发的状态必须标记为确定性视觉夹具，不得伪装成真实运行证据。
- CSS 收口以最终计算样式不变为前提：合并重复主题 token，保留响应式和状态变体，删除被后置规则完全覆盖的声明；业务状态颜色必须复用现有 `--status-*`、`--accent-*` 和 surface token。
- Monaco 优化不得删除已支持语言、编辑命令、Diff、主题、worker 或插件挂载能力；优先通过稳定的 Rollup 分包边界隔离编辑器核心、语言服务与 Markdown/终端依赖，不为消除告警而提高告警阈值。
- 视觉回归以仓库基线和 `visual-verdict` 为双重证据；浅色/深色至少各覆盖登录或工作台一种关键状态，1280px、1024px、768px 均不得出现水平溢出或不可达操作。
- 最终验收必须运行后端测试与类型检查、前端生产构建、UI contract、Diff whitespace 检查，并记录仍不可消除的第三方包体积警告。
