import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { comparePngBuffers, createBaselineResult } from "../services/visualRunner";

function png(width: number, height: number, color: [number, number, number, number]): Buffer {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = color[0];
    image.data[index + 1] = color[1];
    image.data[index + 2] = color[2];
    image.data[index + 3] = color[3];
  }
  return PNG.sync.write(image);
}

describe("visual comparison", () => {
  it("passes identical images", () => {
    const image = png(4, 4, [0, 0, 0, 255]);
    expect(comparePngBuffers(image, image, 0.01).status).toBe("passed");
  });

  it("fails when differing pixels exceed the threshold", () => {
    const dark = png(4, 4, [0, 0, 0, 255]);
    const light = png(4, 4, [255, 255, 255, 255]);
    expect(comparePngBuffers(dark, light, 0.01)).toMatchObject({ status: "failed", diffRatio: 1 });
  });

  it("fails with a clear image-size mismatch", () => {
    const result = comparePngBuffers(png(4, 4, [0, 0, 0, 255]), png(2, 4, [0, 0, 0, 255]), 0.5);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("Image size mismatch");
  });

  it("returns a pending baseline result when none exists", () => {
    expect(createBaselineResult("artifacts/visual.png")).toMatchObject({
      status: "baseline_created",
      baselinePath: "artifacts/visual.png",
      baselineStatus: "pending",
    });
  });
});
