/**
 * The model list of an agent as a native select. Shared by the New task form
 * and the conversation composer so both offer the same options in the same
 * order. Names come from the computer and are rendered as plain text.
 */

import type { AgentModel } from "../api/types";

interface Props {
  readonly id?: string;
  readonly models: readonly AgentModel[];
  /** A model id, or "" for the agent's own default. */
  readonly value: string;
  readonly onChange: (model: string) => void;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly ariaDescribedBy?: string;
  /**
   * For the chip in the composer: the default model is listed by its own name
   * instead of a separate "Default" entry, and an empty value shows it.
   */
  readonly compact?: boolean;
}

/** The model the agent uses when none is chosen, if the computer says which one. */
export function defaultModelOf(models: readonly AgentModel[]): AgentModel | undefined {
  return models.find((m) => m.isDefault);
}

/** A model from another agent's list, or one that vanished, is never used. */
export function knownModel(models: readonly AgentModel[], model: string): string {
  return models.some((m) => m.id === model) ? model : "";
}

export function ModelSelect({ id, models, value, onChange, disabled, className, ariaLabel, ariaDescribedBy, compact }: Props) {
  const fallback = defaultModelOf(models);
  const folded = compact === true && fallback !== undefined;
  return (
    <select
      id={id}
      className={className}
      value={folded && value === "" ? fallback.id : value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
    >
      {!folded && <option value="">{fallback === undefined ? "Default model" : `Default (${fallback.name})`}</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  );
}
