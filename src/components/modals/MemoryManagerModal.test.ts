import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemoryAnalysis, MemoryCleanupResult, MemoryReclaimResult } from "../../api/types";

const state = vi.hoisted(() => ({
  analysis: null as MemoryAnalysis | null,
  pending: null as "analysis" | "clean" | "wsl-cache" | "wsl-compact" | null,
  error: null as string | null,
  result: null as MemoryCleanupResult | null,
  wslResult: null as MemoryReclaimResult | null,
  cooldownUntil: 0,
  analyze: vi.fn(), cleanup: vi.fn(), reclaimWsl: vi.fn(), closeModal: vi.fn(), openModal: vi.fn(),
}));
const desktop = vi.hoisted(() => vi.fn(() => true));

vi.mock("../../api/commands", () => ({ isTauri: desktop }));
vi.mock("../../store/memoryStore", () => ({
  useMemoryStore: (select?: (value: typeof state) => unknown) => select ? select(state) : state,
}));
vi.mock("../../store/uiStore", () => ({ useUiStore: (select: (value: typeof state) => unknown) => select(state) }));

import { MemoryManagerModal } from "./MemoryManagerModal";
import { MemoryReclaimButton } from "../shell/MemoryReclaimButton";

const gib = 1024 ** 3;
const analysis: MemoryAnalysis = {
  system: { totalBytes: 16 * gib, availableBytes: 6 * gib, usedBytes: 10 * gib, commitBytes: 12 * gib,
    commitLimitBytes: 24 * gib, sampledAtMs: 1_792_721_800_000 },
  supported: true, reason: null, wsl: { supported: true, reason: null }, running: false, cooldownRemainingMs: 0,
  processes: [
    { pid: 234, createdAt: "234-time", name: "Editor.exe", workingSetBytes: gib, privateBytes: gib / 2, eligible: true, reason: null },
    { pid: 456, createdAt: "456-time", name: "VmmemWSL", workingSetBytes: 4 * gib, privateBytes: null, eligible: false, reason: "请使用 WSL 缓存回收" },
    { pid: 789, createdAt: null, name: "Protected.exe", workingSetBytes: 2 * gib, privateBytes: null, eligible: false, reason: "权限不足" },
  ],
};

function render(): string { return renderToStaticMarkup(createElement(MemoryManagerModal)); }
function inputFor(markup: string, label: string): string {
  return markup.match(/<input[^>]*>/g)?.find((input) => input.includes(`aria-label="${label}"`)) ?? "";
}
function buttonWith(markup: string, label: string): string {
  return markup.match(/<button[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes(label)) ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  desktop.mockReturnValue(true);
  Object.assign(state, { analysis, pending: null, error: null, result: null, wslResult: null, cooldownUntil: 0 });
});

describe("memory management display", () => {
  it("shows host metrics and sorts processes by working set without selecting them", () => {
    const markup = render();
    expect(markup).toContain("16.00 GiB");
    expect(markup).toContain("62.5% 已用");
    expect(markup).toContain("提交内存 / 上限");
    expect(markup.indexOf('title="VmmemWSL"')).toBeLessThan(markup.indexOf('title="Protected.exe"'));
    expect(markup.indexOf('title="Protected.exe"')).toBeLessThan(markup.indexOf('title="Editor.exe"'));
    const editor = inputFor(markup, "整理 Editor.exe（PID 234）");
    expect(editor).not.toContain('disabled=""');
    expect(editor).not.toContain('checked=""');
    expect(inputFor(markup, "整理 Protected.exe（PID 789）")).toContain('disabled=""');
    expect(inputFor(markup, "整理 VmmemWSL（PID 456）")).toContain('disabled=""');
    expect(buttonWith(markup, "一键清理")).toContain('disabled=""');
    expect(buttonWith(markup, "回收 WSL 缓存")).not.toContain('disabled=""');
    expect(markup.match(/<input[^>]*>/g)?.every((input) => !input.includes('checked=""'))).toBe(true);
  });

  it("disables desktop actions in browser preview and displays the limitation", () => {
    desktop.mockReturnValue(false);
    state.analysis = null;
    const markup = render();
    expect(markup).toContain("浏览器预览无法读取电脑内存");
    expect(buttonWith(markup, "刷新分析")).toContain('disabled=""');
    expect(buttonWith(markup, "一键清理")).toContain('disabled=""');
    expect(buttonWith(markup, "回收 WSL 缓存")).toContain('disabled=""');
    expect(buttonWith(markup, "整理 WSL 空闲页")).toContain('disabled=""');
  });

  it("shows unavailable readings and per-process reasons without assuming zero usage", () => {
    state.analysis = { ...analysis, system: null, reason: "部分内存读数读取失败", wsl: { supported: false, reason: "未连接本机 Docker" } };
    const markup = render();
    expect(markup).toContain("整机内存读数暂不可用");
    expect(markup).toContain("权限不足");
    expect(markup).toContain("未连接本机 Docker");
    expect(markup).toContain("部分内存读数读取失败");
    expect(markup).not.toContain("0.0% 已用");
    expect(buttonWith(markup, "全选当前可整理项")).not.toContain('disabled=""');
    expect(buttonWith(markup, "回收 WSL 缓存")).toContain('disabled=""');
  });

  it("keeps partial failures and WSL cache observations separate from host memory measurements", () => {
    state.result = {
      systemBefore: analysis.system, systemAfter: analysis.system, observationSeconds: 15,
      processes: [{ pid: 234, createdAt: "234-time", name: "<script>alert(1)</script>", status: "skipped", beforeBytes: gib,
        afterBytes: null, reason: "进程已退出" }],
      wsl: { operation: "cache", observationSeconds: 15, cacheBeforeBytes: 2 * gib, cacheAfterBytes: gib,
        hostBeforeBytes: 4 * gib, hostAfterBytes: 4 * gib }, errors: ["<img src=x onerror=alert(1)> 权限不足"],
    };
    const markup = render();
    expect(markup).toContain("部分操作未完成");
    expect(markup).toContain("进程已退出");
    expect(markup).toContain("不等于 Windows 已收回同样多的内存");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<img");
  });

  it("keeps the titlebar entry available while a cleanup is running", () => {
    state.pending = "clean";
    const markup = renderToStaticMarkup(createElement(MemoryReclaimButton));
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("清理中…");
    expect(markup).not.toContain('disabled=""');
    expect(render()).toContain("可关闭面板后查看结果");
  });

  it("allows manual refresh when a backend operation was observed outside this panel", () => {
    state.analysis = { ...analysis, running: true };
    const markup = render();
    expect(buttonWith(markup, "刷新分析")).not.toContain('disabled=""');
    expect(buttonWith(markup, "回收 WSL 缓存")).toContain('disabled=""');
    expect(markup).toContain("不能修复内存泄漏");
    expect(markup).toContain("私有提交量");
  });
});
