import { expect, it } from "vitest";
import { regionEnvErrors } from "./containerRegion";

it("时区和语言的显式选择不允许被手写变量悄悄覆盖", () => {
  expect(regionEnvErrors("UTC", "en_US.UTF-8", ["TZ=Asia/Tokyo", "LC_ALL=C", "FOO=1"])).toHaveLength(2);
  expect(regionEnvErrors(null, "en_US.UTF-8", ["TZ=Asia/Tokyo"])).toEqual([]);
  expect(regionEnvErrors("UTC", null, ["LANG=custom", "LANGUAGE=custom", "LC_ALL=custom"])).toEqual([]);
  expect(regionEnvErrors(null, null, ["TZ=custom", "LANG=custom"])).toEqual([]);
});
