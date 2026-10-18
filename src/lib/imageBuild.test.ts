import { describe, expect, it } from "vitest";
import { appendBuildLog, buildProgress, BUILD_LOG_KEEP } from "./imageBuild";

describe("镜像构建输出", () => {
  it("按最近的 Step 行计算进度，未开始时为空", () => {
    expect(buildProgress([])).toBeNull();
    expect(buildProgress(["Sending build context", "node: Pulling fs layer"])).toBeNull();
    const log = ["Step 1/19 : FROM node:22-bookworm-slim", " ---> abc", "Step 4/19 : RUN apt-get update", "Get:1 http://deb.debian.org"];
    expect(buildProgress(log)).toEqual({ step: 4, total: 19 });
  });
  it("日志超出上限时丢弃最旧的行", () => {
    let log: string[] = [];
    for (let i = 0; i < BUILD_LOG_KEEP + 3; i += 1) log = appendBuildLog(log, String(i));
    expect(log).toHaveLength(BUILD_LOG_KEEP);
    expect(log[0]).toBe("3");
    expect(log[log.length - 1]).toBe(String(BUILD_LOG_KEEP + 2));
  });
});
