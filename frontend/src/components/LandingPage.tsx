import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Bot,
  Check,
  Code2,
  Command,
  GitCompare,
  Moon,
  Network,
  ShieldCheck,
  Sun,
  TerminalSquare,
} from "lucide-react";
import { PRODUCT_NAME } from "../brand";
import { BrandMark } from "./BrandMark";
import { useI18n } from "../i18n";

type Theme = "light" | "dark";
type Mode = "ask" | "code" | "review" | "plan";

interface LandingPageProps {
  theme: Theme;
  onToggleTheme: () => void;
  onEnter: () => void;
}

const MODE_COPY: Record<Mode, { zh: [string, string]; en: [string, string] }> = {
  ask: {
    zh: ["理解代码，不打断节奏", "基于当前文件、选区和工作区上下文，快速定位原因并给出可验证结论。"],
    en: ["Understand code without losing flow", "Use the current file, selection, and workspace context to reach a verifiable answer."],
  },
  code: {
    zh: ["把需求直接落到代码", "读取相关文件、完成编辑、运行验证，再把变更和证据交给你审阅。"],
    en: ["Turn intent directly into code", "Read the relevant files, edit, verify, and present the changes with evidence."],
  },
  review: {
    zh: ["先看风险，再决定合并", "按严重度组织发现，关联到具体文件与行，并给出最小修复建议。"],
    en: ["See risk before you merge", "Rank findings by severity, link them to exact files, and suggest the smallest repair."],
  },
  plan: {
    zh: ["复杂任务先形成路径", "拆解依赖、测试与交付边界，在改动之前建立可执行计划。"],
    en: ["Create a path before complex work", "Map dependencies, tests, and delivery boundaries before changing source."],
  },
};

export const LandingPage: React.FC<LandingPageProps> = ({
  theme,
  onToggleTheme,
  onEnter,
}) => {
  const { locale } = useI18n();
  const isZh = locale === "zh-CN";
  const [mode, setMode] = useState<Mode>("code");
  const copy = useMemo(() => MODE_COPY[mode][isZh ? "zh" : "en"], [isZh, mode]);

  useEffect(() => {
    const scrollTargets = [document.documentElement, document.body, document.getElementById("root")];
    scrollTargets.forEach((target) => target?.classList.add("landing-scroll"));
    return () => {
      scrollTargets.forEach((target) => target?.classList.remove("landing-scroll"));
      window.scrollTo({ top: 0, behavior: "auto" });
    };
  }, []);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  };

  const goTo = (id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    const navHeight = document.querySelector<HTMLElement>(".landing-nav")?.offsetHeight || 0;
    const scrollContainer = document.scrollingElement || document.documentElement;
    const top = Math.max(0, target.getBoundingClientRect().top + scrollContainer.scrollTop - navHeight - 12);
    scrollContainer.scrollTo({ top, behavior: "smooth" });
  };

  return (
    <div className="landing-page">
      <header className="landing-nav">
        <button className="landing-brand-button" type="button" onClick={scrollToTop}>
          <BrandMark size={28} title={PRODUCT_NAME} />
        </button>
        <nav className="landing-nav-links" aria-label={isZh ? "首页导航" : "Landing navigation"}>
          <button type="button" onClick={() => goTo("capabilities")}>{isZh ? "产品能力" : "Capabilities"}</button>
          <button type="button" onClick={() => goTo("workflow")}>{isZh ? "任务主线" : "Workflow"}</button>
          <button type="button" onClick={() => goTo("modes")}>{isZh ? "工作模式" : "Modes"}</button>
        </nav>
        <div className="landing-nav-actions">
          <button
            type="button"
            className="landing-theme-button"
            onClick={onToggleTheme}
            aria-label={theme === "light" ? "切换到暗色主题" : "切换到亮色主题"}
          >
            {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          <button type="button" className="landing-enter-button" onClick={onEnter}>
            {isZh ? "进入工作台" : "Enter workspace"}
          </button>
        </div>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-hero-copy">
            <div className="landing-badge"><span />{isZh ? "完全离线 · 本地运行 · v0.7.0" : "Fully offline · Local runtime · v0.7.0"}</div>
            <h1>{isZh ? "安静的 AI 编程工作台" : "The quiet AI coding workbench"}</h1>
            <p>{isZh
              ? "把编辑器当作画布，把任务当作主线。接入任意 OpenAI 兼容模型，在本地完成读写、审阅与多智能体协作。"
              : "Treat the editor as the canvas and the task as the through-line. Connect any OpenAI-compatible model and work entirely on your own machine."}</p>
            <div className="landing-hero-actions">
              <button type="button" className="landing-primary" onClick={onEnter}>
                {isZh ? "进入工作区" : "Enter workspace"}<ArrowRight size={16} />
              </button>
              <button type="button" className="landing-secondary" onClick={() => goTo("workbench-preview")}>
                {isZh ? "预览工作台" : "Preview workbench"}<kbd>⌘K</kbd>
              </button>
            </div>
            <div className="landing-stats">
              <div><strong>1</strong><span>{isZh ? "Docker 容器启动" : "Docker container"}</span></div>
              <div><strong>4</strong><span>Ask / Code / Review / Plan</span></div>
              <div><strong>0</strong><span>{isZh ? "外网数据出域" : "External data egress"}</span></div>
            </div>
          </div>

          <div className="landing-workbench-preview" id="workbench-preview" aria-label={isZh ? "工作台预览" : "Workbench preview"}>
            <div className="landing-preview-bar"><span /><span /><span /><code>workspace / src / auth / session.ts</code></div>
            <div className="landing-preview-body">
              <div className="landing-preview-rail"><i /><i /><i /><i /></div>
              <div className="landing-preview-code">
                <p><b>18</b><em>export function</em> isSessionValid(s) {'{'}</p>
                <p><b>19</b>&nbsp;&nbsp;<em>if</em> (!s?.token) <em>return false</em>;</p>
                <p><b>20</b>&nbsp;&nbsp;<em>return</em> s.expiresAt &gt; Date.now();</p>
                <p><b>21</b>{'}'}</p>
                <p><b>22</b></p>
                <p><b>23</b><em>export async function</em> guard() {'{'}</p>
                <p><b>24</b>&nbsp;&nbsp;<em>return</em> redirect(<u>"/login"</u>);</p>
              </div>
              <div className="landing-preview-task">
                <span className="landing-preview-chip"><i />Code · {isZh ? "运行中" : "Running"}</span>
                <strong>{isZh ? "修复会话过期后的登录重定向" : "Fix redirect after session expiry"}</strong>
                <span className="landing-preview-line wide" />
                <span className="landing-preview-line" />
                <span className="landing-preview-line short" />
                <small>{isZh ? "上下文 42% · 3 变更" : "Context 42% · 3 changes"}</small>
              </div>
            </div>
          </div>
        </section>

        <div className="landing-trust">
          <span>{isZh ? "核心承诺" : "Core promise"}</span>
          {[isZh ? "100% 离线运行" : "100% offline", isZh ? "Docker 一键部署" : "One-step Docker", isZh ? "多智能体协作" : "Multi-agent", isZh ? "数据不出内网" : "Private by default"].map((item) => (
            <strong key={item}><Check size={15} />{item}</strong>
          ))}
        </div>

        <section className="landing-section" id="capabilities">
          <div className="landing-section-heading">
            <span>{isZh ? "产品能力" : "Capabilities"}</span>
            <h2>{isZh ? "为开发者打造的本地 Agent 环境" : "A local agent environment built for developers"}</h2>
            <p>{isZh ? "从文件上下文到验证证据，所有高频动作都在同一个工作台内完成。" : "Keep files, agent context, edits, and verification evidence in one coherent workspace."}</p>
          </div>
          <div className="landing-feature-grid">
            {[
              [Code2, isZh ? "编辑器为中心" : "Editor-centered", isZh ? "Monaco、Diff、预览与文件上下文保持连续。" : "Monaco, diffs, previews, and file context stay continuous."],
              [Bot, isZh ? "任务优先" : "Task-first", isZh ? "当前阶段、工具、变更和下一步始终可见。" : "Current phase, tools, changes, and next actions stay visible."],
              [Network, isZh ? "多智能体协作" : "Multi-agent", isZh ? "规划、执行、审阅角色可以并行协作。" : "Planning, execution, and review roles can collaborate."],
              [ShieldCheck, isZh ? "私有部署" : "Private deployment", isZh ? "模型、代码和记忆均可留在你的网络边界内。" : "Models, code, and memory can remain inside your network."],
              [TerminalSquare, isZh ? "真实工具链" : "Real toolchain", isZh ? "终端、文件系统、Git 和测试不是模拟层。" : "Terminal, filesystem, Git, and tests are first-class tools."],
              [GitCompare, isZh ? "可审阅交付" : "Reviewable delivery", isZh ? "每次结果都关联变更范围、Diff 与验证状态。" : "Every result connects to changes, diffs, and verification."],
            ].map(([Icon, title, description]) => (
              <article key={String(title)}><Icon size={19} /><h3>{String(title)}</h3><p>{String(description)}</p></article>
            ))}
          </div>
        </section>

        <section className="landing-section landing-workflow" id="workflow">
          <div className="landing-section-heading">
            <span>{isZh ? "任务主线" : "Workflow"}</span>
            <h2>{isZh ? "从提问到交付，一条连续路径" : "One continuous path from intent to delivery"}</h2>
          </div>
          <div className="landing-flow-grid">
            {(isZh
              ? [["01", "建立上下文", "工作区、当前文件与选区"], ["02", "执行任务", "读取、编辑与运行工具"], ["03", "呈现证据", "变更、Diff 与测试结果"], ["04", "继续协作", "审阅、修正或开启下一步"]]
              : [["01", "Ground context", "Workspace, file, and selection"], ["02", "Execute", "Read, edit, and run tools"], ["03", "Show evidence", "Changes, diffs, and tests"], ["04", "Continue", "Review, steer, or start next"]]
            ).map(([number, title, description]) => (
              <article key={number}><span>{number}</span><h3>{title}</h3><p>{description}</p></article>
            ))}
          </div>
        </section>

        <section className="landing-section landing-modes" id="modes">
          <div className="landing-section-heading">
            <span>{isZh ? "工作模式" : "Modes"}</span>
            <h2>{isZh ? "四种模式，同一个任务面板" : "Four modes, one task dock"}</h2>
          </div>
          <div className="landing-mode-shell">
            <div className="landing-mode-tabs" role="tablist" aria-label={isZh ? "工作模式" : "Agent mode"}>
              {(["ask", "code", "review", "plan"] as Mode[]).map((item) => (
                <button key={item} type="button" role="tab" aria-selected={mode === item} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>{item[0].toUpperCase() + item.slice(1)}</button>
              ))}
            </div>
            <div className="landing-mode-content">
              <div><span>{mode.toUpperCase()}</span><h3>{copy[0]}</h3><p>{copy[1]}</p></div>
              <div className="landing-mode-card"><Command size={17} /><strong>{isZh ? "任务证据" : "Task evidence"}</strong><p>{mode === "code" ? "session.ts +18 / −4 · login.ts +9 / −1" : copy[1]}</p><small>{isZh ? "打开详情继续" : "Open details to continue"}</small></div>
            </div>
          </div>
        </section>

        <section className="landing-cta">
          <BrandMark size={34} title={PRODUCT_NAME} />
          <h2>{isZh ? "让 AI 安静地进入你的开发流程" : "Bring AI quietly into your development flow"}</h2>
          <p>{isZh ? "本地部署，完整掌控，随时开始。" : "Deploy locally, stay in control, and start when you are ready."}</p>
          <button type="button" className="landing-primary" onClick={onEnter}>{isZh ? "进入工作台" : "Enter workspace"}<ArrowRight size={16} /></button>
        </section>
      </main>

      <footer className="landing-footer"><BrandMark size={22} title={PRODUCT_NAME} /><span>© 2026 · {isZh ? "私有 AI 编程工作台" : "Private AI coding workbench"}</span></footer>
    </div>
  );
};
