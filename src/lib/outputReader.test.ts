import { describe, expect, it } from "vitest";
import { emptyOutputs, mergeOutputs, outputLink } from "./outputReader";
import type { OutputItem, OutputSnapshot } from "../api/types";
const item = (id: string): OutputItem => ({ id, title: id, kind: "document", filePath: `/workspace/${id}.md`, markdown: id, timestamp: null, truncated: false, revision: id });
const snapshot = (items: OutputItem[], conversationId = "a"): OutputSnapshot => ({ items, conversationId, revision: "v1", status: "ready", limited: false });
describe("output reader selection", () => {
  it("new output never replaces the selected older document", () => {
    const state = mergeOutputs(emptyOutputs(), snapshot([item("old")]));
    expect(mergeOutputs(state, snapshot([item("new"), item("old")])).selectedId).toBe("old");
  });
  it("conversation changes and removed documents select the newest available item", () => {
    const state = mergeOutputs(emptyOutputs(), snapshot([item("old")]));
    expect(mergeOutputs(state, snapshot([item("new")], "b")).selectedId).toBe("new");
    expect(mergeOutputs(state, snapshot([])).selectedId).toBeNull();
  });
  it("unchanged revisions retain body references and limits", () => {
    const state = { ...mergeOutputs(emptyOutputs(), snapshot([item("old")])), limited: true };
    expect(mergeOutputs(state, { ...snapshot([]), items: null })).toBe(state);
  });
  it("only explicit HTTP(S) links can be opened", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "../plan.md", "//example.com"]) expect(outputLink(url)).toBeNull();
    expect(outputLink("https://example.com/plan")).toBe("https://example.com/plan");
  });
});
