import { describe, expect, it } from "vitest";
import { OPEN_SOURCE_REGISTRY, checkOpenSourceBoundaries } from "./open-source-components";

describe("开源组件来源与产品边界", () => {
  it("固定四个实际下载来源的版本、许可证和排除项", () => {
    expect(OPEN_SOURCE_REGISTRY).toHaveLength(4);
    expect(OPEN_SOURCE_REGISTRY.map((source) => source.license)).toEqual([
      "Apache-2.0",
      "CC0-1.0",
      "CC-BY-4.0",
      "MIT",
    ]);
    for (const source of OPEN_SOURCE_REGISTRY) {
      expect(source.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(source.used.length).toBeGreaterThan(0);
      expect(source.excluded.length).toBeGreaterThan(0);
    }
  });

  it("拦截虚假亲历、保证性安慰和治疗越权", () => {
    expect(
      checkOpenSourceBoundaries(
        "我也经历过，所以我保证一定会好。接下来我来治疗你，并给你布置作业。"
      )
    ).toEqual(
      expect.arrayContaining([
        "false_self_disclosure",
        "unsupported_reassurance",
        "therapy_or_homework_overreach",
      ])
    );
  });
});
