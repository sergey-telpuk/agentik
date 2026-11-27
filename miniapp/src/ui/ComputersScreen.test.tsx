import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentikApi, Computer, ComputerStatus } from "../api/types";
import { ComputersScreen } from "./ComputersScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const STATUSES: ComputerStatus[] = ["online", "offline", "pending_confirmation", "replaced", "revoked"];

function computer(status: ComputerStatus, index: number): Computer {
  return {
    id: `abcd${index}efghijklmnop`,
    name: `Box ${status}`,
    status,
    lastSeenAt: status === "online" ? 1_000 : null,
    relayUrl: "wss://relay.example",
    pairedAt: 0,
  };
}

async function show(computers: Computer[], onOpen = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  const api = { listComputers: () => Promise.resolve({ ok: true, value: computers }) } as unknown as AgentikApi;
  await act(async () => {
    root.render(
      <ComputersScreen
        api={api}
        persistence={{ status: "ready" } as never}
        onAdd={() => undefined}
        onOpen={onOpen}
        onSettings={() => undefined}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return onOpen;
}

describe("ComputersScreen row", () => {
  it("renders icon, name, short id and OPEN", async () => {
    const c = computer("online", 1);
    await show([c]);
    const row = container.querySelector("li.computer-row");
    expect(row).not.toBeNull();
    const icon = row?.querySelector("img.computer-icon");
    expect(icon?.getAttribute("src")).toMatch(/^data:image\/svg\+xml|\.svg$/);
    expect(icon?.getAttribute("alt")).toBe("");
    expect(row?.querySelector(".computer-name")?.textContent).toBe("Box online");
    expect(row?.querySelector(".computer-id")?.textContent).toBe("abcd 1efg …");
    const open = row?.querySelector("button.button-primary");
    expect(open?.textContent).toBe("OPEN");
    expect(open?.getAttribute("aria-label")).toBe("Open Box online");
  });

  it("renders no status text, chip or marker for any status", async () => {
    await show(STATUSES.map(computer));
    const rows = [...container.querySelectorAll("li.computer-row")];
    expect(rows).toHaveLength(STATUSES.length);
    for (const row of rows) {
      expect(row.querySelector(".chip, .dot")).toBeNull();
      // The row holds the name, the id and OPEN only.
      expect(row.textContent).toMatch(/^Box [a-z_]+\w{4} \w{4} …OPEN$/);
      expect(row.textContent).not.toMatch(/seen|never|!/i);
    }
  });

  it("opens the computer from the OPEN button, the name area and the row", async () => {
    const c = computer("online", 1);
    const onOpen = await show([c]);
    const row = container.querySelector<HTMLElement>("li.computer-row");
    for (const target of [
      row?.querySelector<HTMLElement>("button.button-primary"),
      row?.querySelector<HTMLElement>("button.computer-row-main"),
      row,
    ]) {
      await act(async () => {
        target?.click();
      });
    }
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(onOpen).toHaveBeenLastCalledWith(c);
  });

  it("keeps the row keyboard focusable through real buttons", async () => {
    await show([computer("online", 1)]);
    const buttons = [...container.querySelectorAll("li.computer-row button")];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b.getAttribute("tabindex")).not.toBe("-1");
      expect((b as HTMLButtonElement).disabled).toBe(false);
    }
  });
});

describe("ComputersScreen empty state", () => {
  const BASE = import.meta.env.BASE_URL;

  function block(): Element | null {
    return container.querySelector(".get-started");
  }

  it("shows the get-started block when no computer is paired", async () => {
    await show([]);
    expect(container.textContent).toContain("No computers paired yet.");
    expect(block()).not.toBeNull();
  });

  it("has the three sections in order", async () => {
    await show([]);
    const titles = [...(block()?.querySelectorAll("section h3") ?? [])].map((h) => h.textContent);
    expect(titles).toEqual(["What to download", "How it works", "How secure it is"]);
    const steps = [...(block()?.querySelectorAll("ol.steps li") ?? [])].map((li) => li.textContent);
    expect(steps).toEqual([
      "Download the file for your computer and check the checksum.",
      "In a terminal on that computer, run the daemon with -pair.",
      "Paste the invitation or scan the QR code here.",
      "Confirm the pairing with “y” in that terminal.",
    ]);
    expect(block()?.querySelectorAll("ul.bullets li")).toHaveLength(9);
    const text = block()?.textContent ?? "";
    expect(text).toContain("end to end (Noise protocol)");
    expect(text).toContain("direct WebRTC connection");
    expect(text).toContain("never carries your messages");
    expect(text).toContain("runs no server");
    expect(text).toContain("unless a TURN server is configured");
    expect(text).toContain("not signed yet");
    // The limits matter as much as the guarantees.
    expect(text).toContain("network addresses, timing and message sizes");
    expect(text).toContain("send your code and prompts to their own provider");
  });

  it("links to the files under BASE_URL", async () => {
    await show([]);
    const links = [...(block()?.querySelectorAll("a") ?? [])].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["Apple Silicon (arm64)", `${BASE}downloads/agentik-darwin-arm64`],
      ["Intel (amd64)", `${BASE}downloads/agentik-darwin-amd64`],
      ["Checksums (SHA256SUMS)", `${BASE}downloads/SHA256SUMS`],
      ["All files and instructions", `${BASE}downloads/`],
    ]);
    for (const a of block()?.querySelectorAll("a") ?? []) {
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("is not shown when a computer is listed", async () => {
    await show([computer("online", 1)]);
    expect(block()).toBeNull();
    expect(container.textContent).not.toContain("What to download");
  });
});
