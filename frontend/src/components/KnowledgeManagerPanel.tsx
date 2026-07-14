import React, { useCallback, useEffect, useState } from "react";
import { BookOpen, Brain, Eye, RefreshCw, Save, Search, ToggleLeft, ToggleRight, Trash2 } from "lucide-react";
import { useAdminSettings } from "../hooks/useAdminSettings";
import { useI18n } from "../i18n";
import {
  MemoryEntry,
  MemoryScope,
  SkillDetail,
  SkillSummary,
  SkillUsageRecord,
} from "../types";

interface KnowledgeManagerPanelProps {
  token: string;
  visible: boolean;
  isAdmin: boolean;
  onShowToast: (message: string) => void;
}

const MEMORY_SCOPES: MemoryScope[] = ["user", "workspace"];

export const KnowledgeManagerPanel: React.FC<KnowledgeManagerPanelProps> = ({
  token,
  visible,
  isAdmin,
  onShowToast,
}) => {
  const { t } = useI18n();
  const adminSettings = useAdminSettings(token);
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [memoryDrafts, setMemoryDrafts] = useState<Record<MemoryScope, string>>({ user: "", workspace: "" });
  const [loadingMemory, setLoadingMemory] = useState(false);
  const [savingMemory, setSavingMemory] = useState<MemoryScope | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillQuery, setSkillQuery] = useState("");
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null);
  const [skillUsage, setSkillUsage] = useState<SkillUsageRecord[]>([]);
  const [loadingSkillDetail, setLoadingSkillDetail] = useState(false);
  const [updatingSkill, setUpdatingSkill] = useState<string | null>(null);

  const applyMemory = useCallback((entries: MemoryEntry[]) => {
    setMemory(entries);
    setMemoryDrafts({
      user: entries.find((entry) => entry.scope === "user")?.content || "",
      workspace: entries.find((entry) => entry.scope === "workspace")?.content || "",
    });
  }, []);

  const loadMemory = useCallback(async () => {
    setLoadingMemory(true);
    try {
      applyMemory(await adminSettings.fetchMemory());
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : t("settings.knowledgeLoadFailed"));
    } finally {
      setLoadingMemory(false);
    }
  }, [adminSettings, applyMemory, onShowToast, t]);

  const loadSkills = useCallback(async (query = skillQuery) => {
    setLoadingSkills(true);
    try {
      const nextSkills = await adminSettings.fetchSkills(query);
      setSkills(nextSkills);
      setSelectedSkillName((current) => current && nextSkills.some((skill) => skill.name === current) ? current : nextSkills[0]?.name || null);
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : t("settings.knowledgeLoadFailed"));
    } finally {
      setLoadingSkills(false);
    }
  }, [adminSettings, onShowToast, skillQuery, t]);

  const loadSkillDetail = useCallback(async (name: string) => {
    setSelectedSkillName(name);
    setLoadingSkillDetail(true);
    try {
      const [detail, usage] = await Promise.all([
        adminSettings.fetchSkill(name),
        adminSettings.fetchSkillUsage(name),
      ]);
      setSelectedSkill(detail);
      setSkillUsage(usage);
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : t("settings.skillPreviewFailed"));
    } finally {
      setLoadingSkillDetail(false);
    }
  }, [adminSettings, onShowToast, t]);

  useEffect(() => {
    if (!visible || !isAdmin) return;
    void loadMemory();
    void loadSkills("");
  }, [visible, isAdmin, loadMemory, loadSkills]);

  useEffect(() => {
    if (!visible || !isAdmin || !selectedSkillName) return;
    void loadSkillDetail(selectedSkillName);
  }, [visible, isAdmin, selectedSkillName, loadSkillDetail]);

  const handleSaveMemory = async (scope: MemoryScope) => {
    if (savingMemory) return;
    setSavingMemory(scope);
    try {
      applyMemory(await adminSettings.updateMemory(scope, memoryDrafts[scope]));
      onShowToast(t("settings.memorySaved"));
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : t("settings.memorySaveFailed"));
    } finally {
      setSavingMemory(null);
    }
  };

  const handleClearMemory = async (scope: MemoryScope) => {
    if (savingMemory || !window.confirm(t("settings.memoryClearConfirm"))) return;
    setSavingMemory(scope);
    try {
      applyMemory(await adminSettings.deleteMemory(scope));
      onShowToast(t("settings.memoryCleared"));
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : t("settings.memorySaveFailed"));
    } finally {
      setSavingMemory(null);
    }
  };

  const handleMergeMemory = async (sourceScope: MemoryScope) => {
    if (savingMemory) return;
    const targetScope: MemoryScope = sourceScope === "user" ? "workspace" : "user";
    setSavingMemory(sourceScope);
    try {
      applyMemory(await adminSettings.mergeMemory(sourceScope, targetScope));
      onShowToast(t("settings.memoryMerged"));
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : t("settings.memoryMergeFailed"));
    } finally {
      setSavingMemory(null);
    }
  };

  const handleToggleSkill = async (skill: SkillSummary) => {
    if (updatingSkill) return;
    setUpdatingSkill(skill.name);
    try {
      const updated = await adminSettings.setSkillEnabled(skill.name, !skill.enabled);
      setSkills((current) => current.map((item) => item.name === updated.name ? updated : item));
      setSelectedSkill((current) => current?.name === updated.name ? { ...current, enabled: updated.enabled } : current);
      onShowToast(updated.enabled ? t("settings.skillEnabled") : t("settings.skillDisabled"));
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : t("settings.skillUpdateFailed"));
    } finally {
      setUpdatingSkill(null);
    }
  };

  if (!visible || !isAdmin) return null;

  return (
    <>
      <section className="settings-card settings-card-full">
        <div className="settings-card-header">
          <div className="settings-card-title">
            <Brain size={16} />
            <span>{t("settings.memoryManagement")}</span>
          </div>
          <span className="settings-card-meta">{t("settings.memoryManagementMeta")}</span>
        </div>
        <div className="knowledge-memory-grid">
          {MEMORY_SCOPES.map((scope) => {
            const entry = memory.find((item) => item.scope === scope);
            return (
              <div className="knowledge-memory-card" key={scope}>
                <div className="knowledge-card-heading">
                  <div>
                    <strong>{t(`settings.memoryScope.${scope}`)}</strong>
                    <span>{entry?.path || `.codex/${scope === "user" ? "USER.md" : "MEMORY.md"}`}</span>
                  </div>
                  <span className="settings-role-badge subtle">{entry?.characters || 0}/{entry?.limit || 0}</span>
                </div>
                <textarea
                  className="settings-input knowledge-memory-editor"
                  value={memoryDrafts[scope]}
                  onChange={(event) => setMemoryDrafts((current) => ({ ...current, [scope]: event.target.value }))}
                  placeholder={t("settings.memoryPlaceholder")}
                  disabled={loadingMemory || savingMemory !== null}
                />
                <div className="knowledge-card-actions">
                  <button className="settings-inline-btn" onClick={() => void handleSaveMemory(scope)} disabled={savingMemory !== null}>
                    <Save size={13} /> {savingMemory === scope ? t("settings.saving") : t("common.save")}
                  </button>
                  <button className="settings-inline-btn" onClick={() => void handleMergeMemory(scope)} disabled={savingMemory !== null || !entry?.exists}>
                    {t("settings.memoryMergeTo", { scope: t(`settings.memoryScope.${scope === "user" ? "workspace" : "user"}`) })}
                  </button>
                  <button className="settings-inline-btn danger" onClick={() => void handleClearMemory(scope)} disabled={savingMemory !== null || !entry?.exists}>
                    <Trash2 size={13} /> {t("common.clear")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="settings-card settings-card-full">
        <div className="settings-card-header">
          <div className="settings-card-title">
            <BookOpen size={16} />
            <span>{t("settings.skillsManagement")}</span>
          </div>
          <span className="settings-card-meta">{t("settings.skillsManagementMeta")}</span>
        </div>
        <div className="knowledge-skill-toolbar">
          <label className="knowledge-search">
            <Search size={14} />
            <input className="settings-input" value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void loadSkills(); }} placeholder={t("settings.skillsSearchPlaceholder")} />
          </label>
          <button className="settings-inline-btn" onClick={() => void loadSkills()} disabled={loadingSkills}>
            <RefreshCw size={13} className={loadingSkills ? "chat-spin" : ""} /> {t("common.refresh")}
          </button>
        </div>
        <div className="knowledge-skills-layout">
          <div className="knowledge-skill-list">
            {skills.length === 0 ? (
              <div className="settings-plugin-empty subtle">{t("settings.noSkillsFound")}</div>
            ) : skills.map((skill) => (
              <button className={`knowledge-skill-row${selectedSkillName === skill.name ? " active" : ""}`} key={skill.name} onClick={() => void loadSkillDetail(skill.name)}>
                <div className="knowledge-skill-copy">
                  <div className="knowledge-skill-title"><strong>{skill.name}</strong><span className={`knowledge-status-dot${skill.enabled ? " enabled" : ""}`} /></div>
                  <span>{skill.description}</span>
                  <small>{skill.path} · {t("settings.skillUsageCount", { count: skill.usageCount })}</small>
                </div>
                <span className="knowledge-skill-toggle" title={skill.enabled ? t("settings.skillDisable") : t("settings.skillEnable")} onClick={(event) => { event.stopPropagation(); void handleToggleSkill(skill); }}>
                  {updatingSkill === skill.name ? <RefreshCw size={14} className="chat-spin" /> : skill.enabled ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                </span>
              </button>
            ))}
          </div>
          <div className="knowledge-skill-preview">
            {loadingSkillDetail ? <div className="settings-loading">{t("common.loading")}</div> : selectedSkill ? (
              <>
                <div className="knowledge-preview-header">
                  <div>
                    <div className="knowledge-skill-title"><Eye size={14} /><strong>{selectedSkill.name}</strong></div>
                    <span>{selectedSkill.path}</span>
                  </div>
                  <span className={`settings-role-badge${selectedSkill.enabled ? "" : " subtle"}`}>{selectedSkill.enabled ? t("settings.skillEnabledLabel") : t("settings.skillDisabledLabel")}</span>
                </div>
                <div className="knowledge-skill-metadata">
                  {Object.entries(selectedSkill.metadata).map(([key, value]) => <span key={key}><strong>{key}</strong> {value}</span>)}
                </div>
                <pre className="knowledge-skill-body">{selectedSkill.body}</pre>
                <div className="knowledge-usage">
                  <strong>{t("settings.skillRunHistory")}</strong>
                  {skillUsage.length === 0 ? <span>{t("settings.noSkillRuns")}</span> : skillUsage.map((run) => <span key={`${run.runId}-${run.timestamp}`}>{new Date(run.timestamp).toLocaleString()} · {run.status} · {run.mode}</span>)}
                </div>
              </>
            ) : <div className="settings-plugin-empty subtle">{t("settings.selectSkillToPreview")}</div>}
          </div>
        </div>
      </section>
    </>
  );
};
