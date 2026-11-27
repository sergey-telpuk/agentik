import { describe, expect, it } from "vitest";
import {
  TASK_STATES,
  canRequestCancel,
  canTransition,
  isFinalState,
  transition,
  type TaskState,
} from "./taskState";

const FINAL: TaskState[] = ["succeeded", "failed", "cancelled", "recovery_required"];

describe("task state machine", () => {
  it("follows the normal path from accepted to succeeded", () => {
    const path: TaskState[] = ["accepted", "starting", "running", "awaiting_approval", "running", "succeeded"];
    for (let i = 1; i < path.length; i++) {
      expect(transition(path[i - 1] as TaskState, path[i] as TaskState)).toEqual({ ok: true, state: path[i] });
    }
  });

  it("confirms a stop only after it was requested", () => {
    expect(canTransition("running", "cancelled")).toBe(false);
    expect(canTransition("running", "cancel_requested")).toBe(true);
    expect(canTransition("cancel_requested", "cancelled")).toBe(true);
    // The agent may still finish before the stop lands.
    expect(canTransition("cancel_requested", "succeeded")).toBe(true);
  });

  it("never leaves a final state", () => {
    for (const from of FINAL) {
      expect(isFinalState(from)).toBe(true);
      for (const to of TASK_STATES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it("does not move a task backwards", () => {
    expect(transition("running", "starting")).toEqual({ ok: false, from: "running", to: "starting" });
    expect(canTransition("running", "accepted")).toBe(false);
    expect(canTransition("starting", "awaiting_approval")).toBe(false);
  });

  it("can reach recovery_required from every unfinished state", () => {
    for (const from of TASK_STATES.filter((s) => !isFinalState(s))) {
      expect(canTransition(from, "recovery_required")).toBe(true);
    }
  });

  it("allows a stop request only for unfinished tasks without a pending stop", () => {
    expect(canRequestCancel("accepted")).toBe(true);
    expect(canRequestCancel("awaiting_approval")).toBe(true);
    expect(canRequestCancel("cancel_requested")).toBe(false);
    for (const s of FINAL) expect(canRequestCancel(s)).toBe(false);
  });
});
