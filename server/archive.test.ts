import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeps, type AppDeps } from "./app";
import { ArchiveError, createExportStream, importArchive, type ArchiveDeps } from "./archive";
import { loadConfig } from "./config";
import { createThumbnail } from "./thumbnails";

const dirs: string[] = [];
const opened: AppDeps[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prismix-archive-"));
  dirs.push(dir);
  return dir;
}

function open(): AppDeps {
  const deps = createDeps(loadConfig({ DATA_DIR: tempDir() }));
  opened.push(deps);
  return deps;
}

function archiveDeps(deps: AppDeps): ArchiveDeps {
  return {
    repository: deps.repository,
    settings: deps.settings,
    createThumbnail: (blob) => createThumbnail(blob),
  };
}

async function png(width: number, height: number, color: string): Promise<Blob> {
  const bytes = await sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
  return new Blob([new Uint8Array(bytes)], { type: "image/png" });
}

function settingsJson(state: Record<string, unknown>): string {
  return JSON.stringify({ state, version: 26 });
}

async function seed(deps: AppDeps) {
  const original = await png(800, 600, "#ff0000");
  await deps.repository.saveImage({
    id: "img-1",
    prompt: "red",
    modelId: "debug/debug-model",
    modelName: "Debug",
    aspectRatio: "4:3",
    resolution: null,
    width: 800,
    height: 600,
    createdAt: 1000,
    referenceImageIds: ["ref-1"],
    isFavorite: true,
    metadata: { note: "kept" },
    embedding: [0.1, 0.2],
    embeddingModelId: "clip",
    scorecard: { scores: { likeness: 5 } as never, updatedAt: 5 },
    originalBlob: original,
    thumbnailBlob: await createThumbnail(original),
  });
  await deps.repository.saveReferenceImage({
    id: "ref-1",
    name: "ref one",
    blob: await png(10, 10, "#00ff00"),
    sourceGalleryItemId: "img-1",
  });
  deps.settings.setSettingsValue(
    settingsJson({
      apiKeys: { google: "secret" },
      characters: [{ id: "char-1", name: "Asher", text: "", enabled: true, referenceImageIds: [] }],
      styles: [
        { id: "watercolor", name: "Watercolor", text: "", enabled: true },
        { id: "custom/1", name: "Mine", text: "", enabled: true, isCustom: true },
      ],
    })
  );
}

async function exportToFile(deps: AppDeps): Promise<string> {
  const file = path.join(tempDir(), "export.zip");
  await pipeline(await createExportStream(archiveDeps(deps)), fs.createWriteStream(file));
  return file;
}

beforeEach(() => {
  dirs.length = 0;
  opened.length = 0;
});

afterEach(() => {
  for (const deps of opened) deps.db.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("server archive", () => {
  it("round-trips images, references, characters and custom styles", async () => {
    const source = open();
    await seed(source);
    const file = await exportToFile(source);

    const target = open();
    target.settings.setSettingsValue(
      settingsJson({
        characters: [],
        styles: [{ id: "watercolor", name: "W", text: "", enabled: true }],
      })
    );
    const result = await importArchive(file, archiveDeps(target));

    expect(result).toEqual({
      imported: 1,
      referencesImported: 1,
      charactersImported: 1,
      stylesImported: 1,
      skipped: 0,
      failed: 0,
    });
    expect(await target.repository.getAllImages()).toEqual(await source.repository.getAllImages());
    const original = await target.repository.getImageBlob("img-1", "original");
    const thumbnail = await target.repository.getImageBlob("img-1", "thumbnail");
    expect((await sharp(Buffer.from(await original!.arrayBuffer())).metadata()).width).toBe(800);
    expect((await sharp(Buffer.from(await thumbnail!.arrayBuffer())).metadata()).width).toBe(400);
    expect(target.repository.listReferenceMetadata()).toEqual([
      { id: "ref-1", name: "ref one", mimeType: "image/png", sourceGalleryItemId: "img-1" },
    ]);
    const state = target.settings.readSettingsState()!;
    expect((state.characters as Array<{ id: string }>).map((c) => c.id)).toEqual(["char-1"]);
    expect((state.styles as Array<{ id: string }>).map((s) => s.id)).toEqual([
      "watercolor",
      "custom/1",
    ]);

    // Importing again skips everything that already exists.
    const again = await importArchive(file, archiveDeps(target));
    expect(again).toMatchObject({ imported: 0, referencesImported: 0, skipped: 2 });
  });

  it("writes the layout the browser importer reads, without leaking API keys", async () => {
    const source = open();
    await seed(source);
    const zip = await JSZip.loadAsync(fs.readFileSync(await exportToFile(source)));

    const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({
      id: "img-1",
      filename: "images/img-1.png",
      embedding: [0.1, 0.2],
      isFavorite: true,
    });
    expect(zip.file("images/img-1.png")).not.toBeNull();
    expect(JSON.parse(await zip.file("references-manifest.json")!.async("text"))).toEqual([
      {
        id: "ref-1",
        name: "ref one",
        filename: "references/ref-1.png",
        sourceGalleryItemId: "img-1",
      },
    ]);
    expect(
      JSON.parse(await zip.file("custom-styles.json")!.async("text")).map(
        (s: { id: string }) => s.id
      )
    ).toEqual(["custom/1"]);
    expect(JSON.parse(await zip.file("prismix-archive.json")!.async("text"))).toMatchObject({
      format: "prismix-archive",
      version: 1,
    });
    for (const name of Object.keys(zip.files)) {
      if (name.endsWith(".json"))
        expect(await zip.file(name)!.async("text")).not.toContain("secret");
    }
  });

  it("imports an archive in the browser's format, counting broken entries as failed", async () => {
    const zip = new JSZip();
    const image = await png(64, 64, "#0000ff");
    zip.file("images/a.png", await image.arrayBuffer());
    zip.file(
      "manifest.json",
      JSON.stringify([
        // Older exports may lack referenceImageIds/metadata.
        {
          id: "a",
          filename: "images/a.png",
          prompt: "blue",
          modelId: "m",
          modelName: "M",
          aspectRatio: null,
          resolution: null,
          width: 64,
          height: 64,
          createdAt: 1,
        },
        {
          id: "missing-file",
          filename: "images/nope.png",
          prompt: "",
          modelId: "m",
          modelName: "M",
          aspectRatio: null,
          resolution: null,
          width: 1,
          height: 1,
          createdAt: 2,
        },
        { filename: "images/no-id.png" },
      ])
    );
    const file = path.join(tempDir(), "browser.zip");
    fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));

    const target = open();
    const result = await importArchive(file, archiveDeps(target));

    expect(result).toMatchObject({ imported: 1, failed: 2, skipped: 0 });
    expect(await target.repository.getImageById("a")).toMatchObject({
      prompt: "blue",
      referenceImageIds: [],
      metadata: {},
    });
  });

  it("rejects files that aren't archives", async () => {
    const target = open();
    const notZip = path.join(tempDir(), "not.zip");
    fs.writeFileSync(notZip, "hello");
    await expect(importArchive(notZip, archiveDeps(target))).rejects.toBeInstanceOf(ArchiveError);

    const noManifest = new JSZip();
    noManifest.file("readme.txt", "hi");
    const file = path.join(tempDir(), "empty.zip");
    fs.writeFileSync(file, await noManifest.generateAsync({ type: "nodebuffer" }));
    await expect(importArchive(file, archiveDeps(target))).rejects.toThrow("missing manifest.json");
  });
});
