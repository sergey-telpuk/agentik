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
  });
});
