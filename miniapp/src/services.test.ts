import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseBackend, createDefaultServices } from "./services";

describe("backend selection", () => {
  it("is live without a scenario parameter", () => {
    expect(chooseBackend("")).toEqual({ kind: "live" });
    expect(chooseBackend("?tgWebAppStartParam=x")).toEqual({ kind: "live" });
  });

  it("is the mock with the named scenario when the parameter is present", () => {
    expect(chooseBackend("?scenario=approval")).toEqual({ kind: "mock", scenario: "approval" });
    expect(chooseBackend("?foo=1&scenario=no_storage")).toEqual({ kind: "mock", scenario: "no_storage" });
    // Present but unknown or empty still means demo data, never the live backend.
    expect(chooseBackend("?scenario=nope")).toEqual({ kind: "mock", scenario: "happy" });
    expect(chooseBackend("?scenario=")).toEqual({ kind: "mock", scenario: "happy" });
  });

  describe("default services", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    afterEach(() => setItem.mockClear());

    it("build a live API by default and a mock API for ?scenario=, without web storage", async () => {
      const live = createDefaultServices("");
      const liveStore = await live.openStore();
      expect(live.createApi(liveStore).backend).toBe("live");
      // Outside Telegram there is no persistent store, so the live app cannot pin anything.
      expect(liveStore.persistence.status).toBe("unsupported");

      const mock = createDefaultServices("?scenario=happy");
      const api = mock.createApi(await mock.openStore());
      expect(api.backend).toBe("mock");
      expect((await api.getDiagnostics()).scenario).toBe("happy");
      expect(setItem).not.toHaveBeenCalled();
    });

    it("keeps the mock path off the network: connecting to a demo computer never touches WebRTC or a WebSocket", async () => {
      const peer = vi.fn(() => {
        throw new Error("the mock backend must not create an RTCPeerConnection");
      });
      const socket = vi.fn(() => {
        throw new Error("the mock backend must not open a WebSocket");
      });
      vi.stubGlobal("RTCPeerConnection", peer);
      vi.stubGlobal("WebSocket", socket);
      try {
        const mock = createDefaultServices("?scenario=happy");
        const api = mock.createApi(await mock.openStore());
        const computers = await api.listComputers();
        expect(computers.ok).toBe(true);
        const id = computers.ok ? computers.value[0]?.id : undefined;
        expect(id).toBeDefined();
        const states: string[] = [];
        const stop = api.connect(id ?? "", (state) => states.push(state.phase));
        await vi.waitFor(() => expect(states).toContain("ready"), { timeout: 5000 });
        stop();
        expect(peer).not.toHaveBeenCalled();
        expect(socket).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
