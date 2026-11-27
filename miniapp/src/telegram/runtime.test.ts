import { describe, expect, it } from "vitest";
import { noTelegramRuntime, themeToCssVars } from "./runtime";

describe("themeToCssVars", () => {
  it("maps snake_case and camelCase keys to Telegram CSS variables", () => {
    expect(themeToCssVars({ bg_color: "#112233", buttonTextColor: "#ffffff" })).toEqual({
      "--tg-theme-bg-color": "#112233",
      "--tg-theme-button-text-color": "#ffffff",
    });
  });

  it("drops values that are not plain #RRGGBB colours", () => {
    expect(
      themeToCssVars({ bg_color: "red; background: url(x)", text_color: "#12345", hint_color: 7, "x;y": "#000000" }),
    ).toEqual({});
    expect(themeToCssVars(undefined)).toEqual({});
  });

  it("is inert outside Telegram", () => {
    const applied: Record<string, string>[] = [];
    noTelegramRuntime.watchTheme((vars) => applied.push({ ...vars }))();
    noTelegramRuntime.showBackButton(() => {})();
    noTelegramRuntime.ready();
    expect(applied).toEqual([]);
  });
});
