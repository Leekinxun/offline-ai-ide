import React, { useMemo } from "react";
import { WorkbenchSelect, WorkbenchSelectOption } from "./WorkbenchSelect";

interface ModelSelectorProps {
  value: string;
  models: string[];
  automaticLabel: string;
  label: string;
  disabled?: boolean;
  className?: string;
  onChange: (value: string) => void;
}

function getModelBadge(modelName: string): string {
  const trimmed = modelName.trim();
  if (!trimmed) return "LLM";
  const provider = trimmed.includes("/") ? trimmed.split("/")[0] : trimmed.split("-")[0];
  return provider.slice(0, 4).toUpperCase();
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  value,
  models,
  automaticLabel,
  label,
  disabled = false,
  className,
  onChange,
}) => {
  const options = useMemo<WorkbenchSelectOption[]>(
    () => [
      { value: "", label: automaticLabel, meta: "AUTO" },
      ...models.map((model) => ({
        value: model,
        label: model,
        meta: getModelBadge(model),
      })),
    ],
    [automaticLabel, models]
  );

  return (
    <WorkbenchSelect
      value={value}
      options={options}
      onChange={onChange}
      label={label}
      disabled={disabled}
      className={["model-selector", className].filter(Boolean).join(" ")}
    />
  );
};
