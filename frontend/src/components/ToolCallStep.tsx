import React, { useState, useCallback } from "react";
import { FileUpdate, ToolCallStep as ToolCallStepType } from "../types";
import {
  Terminal,
  FileText,
  FilePenLine,
  FileOutput,
  ListChecks,
  ChevronRight,
  ChevronDown,
  Loader2,
  Users,
  MessageSquare,
  AlertCircle,
  Crosshair,
} from "lucide-react";

const TOOL_ICONS: Record<string, React.ReactNode> = {
  bash: <Terminal size={13} />,
  read_file: <FileText size={13} />,
  write_file: <FileOutput size={13} />,
  edit_file: <FilePenLine size={13} />,
  TodoWrite: <ListChecks size={13} />,
  task: <Users size={13} />,
  spawn_teammate: <Users size={13} />,
  send_message: <MessageSquare size={13} />,
};

function toolIcon(name: string): React.ReactNode {
  return TOOL_ICONS[name] || <Terminal size={13} />;
}

function abbreviateInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "bash":
      return String(input.command || "");
    case "read_file":
      return String(input.path || "");
    case "write_file":
      return String(input.path || "");
    case "edit_file":
      return String(input.path || "");
    case "TodoWrite":
      return `${(input.items as unknown[])?.length || 0} items`;
    case "task":
      return String(input.prompt || "").slice(0, 80);
    default:
      return JSON.stringify(input).slice(0, 100);
  }
}

interface Props {
  step: ToolCallStepType;
  onNavigateToFileUpdate?: (update: FileUpdate) => void;
}

export const ToolCallStep: React.FC<Props> = ({
  step,
  onNavigateToFileUpdate,
}) => {
  const [expanded, setExpanded] = useState(false);
  const isPending = step.result === undefined;
  const canJumpToEdit =
    step.name === "edit_file" &&
    !!step.fileUpdate?.selection &&
    !step.isError &&
    !!onNavigateToFileUpdate;

  const toggle = useCallback(() => setExpanded((v) => !v), []);
  const handleJump = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (step.fileUpdate && onNavigateToFileUpdate) {
        onNavigateToFileUpdate(step.fileUpdate);
      }
    },
    [onNavigateToFileUpdate, step.fileUpdate]
  );

  return (
    <div className={`tool-call-step${step.isError ? " error" : ""}`}>
      <div className="tool-call-header" onClick={toggle}>
        <span className="tool-call-chevron">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <span className="tool-call-icon">{toolIcon(step.name)}</span>
        <span className="tool-call-name">{step.name}</span>
        <span className="tool-call-summary">{abbreviateInput(step.name, step.input)}</span>
        {canJumpToEdit && (
          <button
            className="tool-call-jump-btn"
            onClick={handleJump}
            title="Jump to edited code"
          >
            <Crosshair size={12} />
            Jump
          </button>
        )}
        {isPending && <Loader2 size={13} className="tool-call-spinner" />}
        {step.isError && <AlertCircle size={13} className="tool-call-error-icon" />}
      </div>
      {expanded && (
        <div className="tool-call-body">
          <div className="tool-call-input">
            <pre>{JSON.stringify(step.input, null, 2)}</pre>
          </div>
          {step.result !== undefined && (
            <div className={`tool-call-result${step.isError ? " error" : ""}`}>
              <pre>{step.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
