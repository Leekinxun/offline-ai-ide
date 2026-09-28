import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import "./AgentQuestionStack.css";

interface Question {
  id: string; requestId: string; runId: string; conversationId: string;
  questions: Array<{ id: string; prompt: string; options: string[]; multiple: boolean }>;
}
interface Answer { id: string; selected: string[]; text: string; }

export function AgentQuestionStack({ token, conversationId }: { token: string; conversationId?: string | null }) {
  const { t } = useI18n();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setQuestions([]); setError(null);
    if (!conversationId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/questions?conversationId=${encodeURIComponent(conversationId)}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        if (!response.ok) throw new Error(t("question.loadFailed"));
        const payload = await response.json();
        if (!controller.signal.aborted) { setQuestions(payload.questions || []); setError(null); }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("question.loadFailed"));
      } finally { if (!controller.signal.aborted) timer = setTimeout(poll, 2000); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [token, conversationId, t]);
  const answer = async (question: Question, answers: Answer[], cancelled = false) => {
    const response = await fetch(`/api/questions/${encodeURIComponent(question.id)}/answer`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: question.requestId, answers, cancelled }),
    });
    if (!response.ok) { const body = await response.json(); throw new Error(body.error || t("question.answerFailed")); }
    setQuestions((current) => current.filter((item) => item.id !== question.id));
  };
  if (!questions.length && !error) return null;
  return <div className="agent-question-stack" aria-live="polite">
    {error && <div role="alert">{error}</div>}
    {questions.map((question) => <QuestionForm key={question.id} question={question} onAnswer={answer} />)}
  </div>;
}

function QuestionForm({ question, onAnswer }: { question: Question; onAnswer: (question: Question, answers: Answer[], cancelled?: boolean) => Promise<void> }) {
  const { t } = useI18n();
  const [answers, setAnswers] = useState<Answer[]>(() => question.questions.map((item) => ({ id: item.id, selected: [], text: "" })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (cancelled = false) => {
    setBusy(true); setError(null);
    try { await onAnswer(question, answers, cancelled); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t("question.answerFailed")); }
    finally { setBusy(false); }
  };
  return <form className="agent-question-card" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <strong>{t("question.waiting")}</strong>
    {question.questions.map((item, index) => <fieldset key={item.id} disabled={busy}>
      <legend>{item.prompt}</legend>
      {item.options.map((option) => <label key={option}>
        <input type={item.multiple ? "checkbox" : "radio"} name={`${question.id}-${item.id}`} checked={answers[index].selected.includes(option)} onChange={(event) => setAnswers((current) => current.map((answer, offset) => offset === index ? { ...answer, selected: item.multiple ? event.target.checked ? [...answer.selected, option] : answer.selected.filter((value) => value !== option) : [option] } : answer))} />
        <span>{option}</span>
      </label>)}
      <textarea aria-label={t("question.freeText")} placeholder={t("question.freeText")} maxLength={4000} value={answers[index].text} onChange={(event) => setAnswers((current) => current.map((answer, offset) => offset === index ? { ...answer, text: event.target.value } : answer))} />
    </fieldset>)}
    {error && <p role="alert">{error}</p>}
    <div className="agent-question-actions">
      <button type="button" disabled={busy} onClick={() => void submit(true)}>{t("question.skip")}</button>
      <button type="submit" disabled={busy || answers.some((answer) => !answer.text.trim() && !answer.selected.length)}>{t("question.submit")}</button>
    </div>
  </form>;
}
