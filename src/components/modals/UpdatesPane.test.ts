import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UpdateStatus } from "../../api/types";
import { UpdatesPane } from "./UpdatesPane";

const store = vi.hoisted(() => ({ status: null as UpdateStatus | null, pending: null, commandError: null,
  check: vi.fn(), download: vi.fn(), install: vi.fn() }));
// React's server renderer normally reads Zustand's initial snapshot. Feed the
// fixture through the selector so this test exercises the release text itself.
vi.mock("../../store/updateStore", () => ({
  useUpdateStore: (select: (state: typeof store) => unknown) => select(store),
  isUpdateBusy: () => false,
  canDownloadUpdate: () => false,
}));

const status: UpdateStatus = { currentVersion: "1.0.2", phase: "available", release: {
  version: "1.0.3", notes: "<img src=x onerror=alert(1)>\n<script>alert(2)</script>", publishedAt: null,
  url: "https://github.com/example/project/releases/tag/v1.0.3",
}, downloadedBytes: 0, totalBytes: null, checkedAt: null, error: null, installKind: "installer" };

afterEach(() => { store.status = null; });

function render(value: UpdateStatus) {
  store.status = value;
  return renderToStaticMarkup(createElement(UpdatesPane, {
    value: { autoCheck: true, autoDownload: true, installOnExit: true }, onChange: () => undefined,
  }));
}

describe("release details rendering", () => {
  it("renders remotely supplied release notes as inert text", () => {
    const markup = render(status);
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script");
    expect(markup).toContain('href="https://github.com/example/project/releases/tag/v1.0.3"');
  });

  it("omits unsafe or unrelated release URLs", () => {
    for (const url of ["javascript:alert(1)", "https://untrusted.example/download", "https://account@github.com/example/project", "invalid"]) {
      expect(render({ ...status, release: { ...status.release!, url } })).not.toContain("在 GitHub 查看发行版");
    }
  });
});
