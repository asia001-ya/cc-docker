import { afterEach, describe, expect, it } from "vitest";
import type { Settings } from "../api/types";
import { DEFAULT_SETTINGS } from "../lib/demo";
import { useUiStore } from "./uiStore";

afterEach(() => useUiStore.getState().setSettings(DEFAULT_SETTINGS));

describe("saved update preferences", () => {
  it("adds automatic update defaults to old settings", () => {
    const legacy = { ...DEFAULT_SETTINGS } as Partial<Settings>;
    delete legacy.updates;
    useUiStore.getState().setSettings(legacy as Settings);
    expect(useUiStore.getState().settings.updates).toEqual({ autoCheck: true, autoDownload: true, installOnExit: true });
  });

  it("fills missing preferences without re-enabling a disabled choice", () => {
    useUiStore.getState().setSettings({ ...DEFAULT_SETTINGS, updates: { autoCheck: false } } as Settings);
    expect(useUiStore.getState().settings.updates).toEqual({ autoCheck: false, autoDownload: true, installOnExit: true });
  });
});
