import { describe, expect, it } from "vitest";
import type { ModelCapabilities, StoredModel } from "~/types";
import { BUILT_IN_MODELS } from "./builtInModels";
import {
  describeModelOptions,
  getModelOptionControls,
  hasModelOptions,
  modelOptionsCostDistance,
  modelOptionsFromSaved,
  resolveModelSettings,
} from "./modelOptions";

const flare = BUILT_IN_MODELS.find((m) => m.id === "openai/gpt-image-2.6-flare")!;
const noRefs = { referenceCount: 0 };
const withRefs = { referenceCount: 2 };

function customModel(capabilities: Partial<ModelCapabilities>): StoredModel {
  return {
    id: "replicate/acme/model",
    name: "Acme",
    provider: "replicate",
    enabled: true,
    capabilities: {
      supportsAspectRatios: false,
      supportsResolution: false,
      supportsReferenceImages: false,
      maxReferenceImages: 0,
      ...capabilities,
    },
  };
}

describe("model options", () => {
  it("shows quality and images per call first, then the model's own options", () => {
    const ids = getModelOptionControls(flare, {}, noRefs).map((c) => c.definition.id);
    expect(ids).toEqual(["quality", "numberOfImages", "complexity", "outputFormat"]);
  });

  it("splits request fields from provider options", () => {
    expect(
      resolveModelSettings(
        flare,
        { quality: "high", numberOfImages: 4, complexity: "low", outputFormat: "gif" },
        noRefs
      )
    ).toEqual({
      quality: "high",
      numberOfImages: 4,
      modelOptions: {
        complexity: "low",
        outputFormat: "gif",
        gifFrameCount: 9,
        gifFrameDurationMs: 200,
      },
    });
  });

  it("defaults to no quality and one image per call", () => {
    expect(resolveModelSettings(flare, undefined, noRefs)).toEqual({
      quality: null,
      numberOfImages: 1,
      modelOptions: {},
    });
  });

  it("clamps images per call to the model's limit", () => {
    expect(resolveModelSettings(flare, { numberOfImages: 50 }, noRefs).numberOfImages).toBe(10);
  });

  it("forces one image per call for SVG and hides the control", () => {
    const raw = { numberOfImages: 4, outputFormat: "svg" };
    expect(resolveModelSettings(flare, raw, noRefs).numberOfImages).toBe(1);
    const ids = getModelOptionControls(flare, raw, noRefs).map((c) => c.definition.id);
    expect(ids).not.toContain("numberOfImages");
  });

  it("restores images per call when SVG becomes unavailable", () => {
    const raw = { numberOfImages: 4, outputFormat: "svg" };
    expect(resolveModelSettings(flare, raw, withRefs)).toMatchObject({
      numberOfImages: 4,
      modelOptions: {},
    });
  });

  it("gives non-OpenAI models with quality or batching their own options", () => {
    const model = customModel({
      supportsQuality: true,
      supportedQualities: ["hd", "high", "low"],
      supportsNumberOfImages: true,
      maxImagesPerRequest: 4,
    });
    expect(hasModelOptions(model)).toBe(true);
    const quality = getModelOptionControls(model, {}, noRefs)[0];
    expect(quality.spec).toEqual({ kind: "enum", values: ["low", "high", "hd"] });
    expect(resolveModelSettings(model, { quality: "hd" }, noRefs).quality).toBe("hd");
  });

  it("gives models without quality, batching, or declared options no section", () => {
    expect(
      hasModelOptions(customModel({ supportsNumberOfImages: true, maxImagesPerRequest: 1 }))
    ).toBe(false);
  });

  it("round-trips saved images back into raw picks", () => {
    const raw = modelOptionsFromSaved({ quality: "low", modelOptions: { complexity: "medium" } });
    expect(resolveModelSettings(flare, raw, noRefs)).toMatchObject({
      quality: "low",
      modelOptions: { complexity: "medium" },
    });
  });

  it("prices only cost-affecting provider options", () => {
    expect(modelOptionsCostDistance(flare, { complexity: "low" }, {})).toBe(0);
    expect(modelOptionsCostDistance(flare, undefined, { outputFormat: "gif" })).toBe(1);
  });

  it("summarizes without noise from defaults", () => {
    expect(describeModelOptions({ quality: "high", numberOfImages: 1 }, { model: flare })).toEqual([
      "High quality",
    ]);
    expect(describeModelOptions({ numberOfImages: 3 }, { model: flare })).toEqual(["3 / call"]);
  });
});
