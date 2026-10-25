import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { loadModule } from "../source-probes.mjs";

const {
  PROJECT_SCHEMA_VERSION,
  MAX_PROJECT_BYTES,
  MAX_MEDIA_BYTES,
  MAX_TIMELINE_SECONDS,
  assertProjectSize,
  assertMediaPayloadSize,
  migrateProjectDocument,
  parseProject,
  serializeProject,
} = loadModule("services/project.ts");

const legacyText = readFileSync(
  "tests/fixtures/drafts/legacy-unversioned.json",
  "utf8",
);
const golden = JSON.parse(
  readFileSync("tests/fixtures/drafts/legacy-unversioned.v2.json", "utf8"),
);

function clip(overrides = {}) {
  return {
    id: "clip",
    base64: "dmlkZW8=",
    mimeType: "video/mp4",
    type: "video",
    name: "Clip",
    duration: 2,
    originalDuration: 4,
    startTime: 0,
    trimStart: 0,
    trimEnd: 0,
    ...overrides,
  };
}
function draft(overrides = {}) {
  return JSON.stringify({ mediaAssets: [clip()], ...overrides });
}
function roundTrip(project) {
  const payloads = new Map(
    project.sources.map((source) => [source.sourceId, source.base64]),
  );
  return serializeProject(project, async (sourceId) => {
    assert.ok(payloads.has(sourceId), "every clip references a parsed source");
    return payloads.get(sourceId);
  });
}

test("legacy migration matches the golden file without mutating the input", () => {
  const legacy = JSON.parse(legacyText);
  const migrated = migrateProjectDocument(legacy);
  assert.deepEqual(migrated, golden);
  assert.equal(migrated.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(legacy.schemaVersion, undefined, "input object is untouched");
  // Media, trims, transitions, audio offsets, canvas options and playhead
  // survive verbatim; only the version stamp and a missing reference differ.
  for (const [key, value] of Object.entries(golden))
    assert.deepEqual(migrated[key], value, `field ${key}`);
  assert.deepEqual(migrated.mediaAssets[0], legacy.mediaAssets[0]);
  assert.deepEqual(migrated.audioTracks, legacy.audioTracks);
  for (const key of ["aspectRatio", "fitMode", "transitionDuration", "currentTime"])
    assert.deepEqual(migrated[key], legacy[key], `preserved ${key}`);
  const { mediaId, ...stillRest } = migrated.mediaAssets[1];
  assert.equal(mediaId, "still", "missing reference rebuilt from the ID");
  assert.deepEqual(stillRest, legacy.mediaAssets[1]);
  assert.equal(
    JSON.stringify(migrateProjectDocument(JSON.parse(legacyText))),
    JSON.stringify(migrated),
    "migration is deterministic",
  );
});

test("current version passes through, version 1 migrates, and unsupported versions are rejected", () => {
  assert.deepEqual(migrateProjectDocument(golden), golden);
  assert.deepEqual(migrateProjectDocument({ ...golden, schemaVersion: 1 }), golden);
  for (const schemaVersion of [3, 9999, 0, -1, 1.5, "1", null, true])
    assert.throws(
      () => migrateProjectDocument({ schemaVersion }),
      /Unsupported project version.*not modified/,
      `version ${JSON.stringify(schemaVersion)}`,
    );
  assert.throws(
    () =>
      parseProject(
        readFileSync("tests/fixtures/drafts/future-version.json", "utf8"),
      ),
    /Unsupported project version/,
  );
});

test("legacy drafts parse and re-save as version 1 with identical payloads", async () => {
  const project = parseProject(legacyText);
  assert.equal(project.sources.length, 3);
  const [intro, still] = project.mediaAssets;
  assert.equal(intro.trimStart, 1.25);
  assert.equal(intro.trimEnd, 2.5);
  assert.equal(intro.originalDuration, 9);
  assert.equal(intro.transitionDuration, 0.75);
  assert.equal(intro.filter, "warm");
  assert.equal(intro.sourceFps, 30);
  assert.equal(still.startTime, 5.25);
  assert.equal(still.mediaId, "still", "missing mediaId falls back to the ID");
  assert.equal(project.audioTracks[0].startTime, 1.25);
  assert.equal(project.aspectRatio, "16:9");
  assert.equal(project.fitMode, "cover");
  assert.equal(project.transitionDuration, 0.5);
  assert.equal(project.currentTime, 2.5);

  const saved = JSON.parse(await roundTrip(project));
  assert.equal(saved.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(saved.mediaAssets[0].base64, "dmlkZW8=");
  assert.equal(saved.audioTracks[0].base64, "YXVkaW8=");
  assert.equal(saved.currentTime, 2.5);
  const reparsed = parseProject(JSON.stringify(saved));
  assert.equal(await roundTrip(reparsed), JSON.stringify(saved));
});


test("timings are bounded: limits are accepted and extremes rejected", () => {
  const ok = parseProject(
    draft({
      mediaAssets: [
        clip({
          type: "image",
          startTime: MAX_TIMELINE_SECONDS,
          duration: MAX_TIMELINE_SECONDS,
          originalDuration: MAX_TIMELINE_SECONDS,
          transitionDuration: MAX_TIMELINE_SECONDS,
        }),
      ],
      currentTime: MAX_TIMELINE_SECONDS,
      transitionDuration: MAX_TIMELINE_SECONDS,
    }),
  );
  assert.equal(ok.mediaAssets[0].startTime, MAX_TIMELINE_SECONDS);
  assert.equal(
    parseProject(draft({ currentTime: -MAX_TIMELINE_SECONDS })).currentTime,
    -MAX_TIMELINE_SECONDS,
  );
  const extreme = MAX_TIMELINE_SECONDS + 0.001;
  for (const [label, textValue] of [
    ["start time", draft({ mediaAssets: [clip({ startTime: extreme })] })],
    ["duration", draft({ mediaAssets: [clip({ duration: extreme })] })],
    ["trim start", draft({ mediaAssets: [clip({ trimStart: extreme })] })],
    ["trim end", draft({ mediaAssets: [clip({ trimEnd: extreme })] })],
    [
      "original duration",
      draft({ mediaAssets: [clip({ originalDuration: extreme })] }),
    ],
    [
      "clip transition",
      draft({ mediaAssets: [clip({ transitionDuration: extreme })] }),
    ],
    ["project transition", draft({ transitionDuration: extreme })],
    ["playhead", draft({ currentTime: extreme })],
    ["negative playhead", draft({ currentTime: -extreme })],
    ["infinite duration", draft({ mediaAssets: [clip({ duration: 1e999 })] })],
    ["infinite start", draft({ mediaAssets: [clip({ startTime: 1e999 })] })],
  ])
    assert.throws(() => parseProject(textValue), /Invalid/, label);
});

test("media references, unique IDs, enums and metadata bounds are validated", () => {
  // Version 1 is strict; only legacy migration rebuilds broken references.
  for (const mediaId of [42, "", "   ", null, {}, []])
    assert.throws(
      () =>
        parseProject(
          draft({
            schemaVersion: PROJECT_SCHEMA_VERSION,
            mediaAssets: [clip({ mediaId })],
          }),
        ),
      /Invalid media reference/,
    );
  const rebuilt = parseProject(
    draft({
      mediaAssets: [clip({ mediaId: "" }), clip({ id: "second", mediaId: 0 })],
    }),
  );
  assert.deepEqual(
    rebuilt.mediaAssets.map((asset) => asset.mediaId),
    ["clip", "second"],
    "legacy empty or invalid references are rebuilt from the entry ID",
  );
  assert.throws(
    () =>
      parseProject(
        draft({
          mediaAssets: [clip()],
          audioTracks: [
            {
              id: "clip",
              base64: "YXVkaW8=",
              mimeType: "audio/mpeg",
              name: "Song",
              startTime: 0,
              duration: 2,
            },
          ],
        }),
      ),
    /Duplicate media ID/,
  );
  assert.throws(
    () => parseProject(draft({ mediaAssets: [clip({ sourceFps: 1001 })] })),
    /Invalid source frame rate/,
  );
  assert.throws(
    () => parseProject(draft({ mediaAssets: [clip({ sourceWidth: 100001 })] })),
    /Invalid source width/,
  );
  assert.throws(() => parseProject(draft({ aspectRatio: "4:3" })), /Invalid/);
  assert.throws(() => parseProject(draft({ fitMode: "stretch" })), /Invalid/);
});

test("size limits are enforced before JSON parsing and media decoding", () => {
  assert.doesNotThrow(() => assertProjectSize(MAX_PROJECT_BYTES));
  assert.throws(() => assertProjectSize(MAX_PROJECT_BYTES + 1), /too large/);
  assert.throws(() => assertProjectSize(-1), /Invalid project file size/);
  const encodedLimit = 4 * Math.ceil(MAX_MEDIA_BYTES / 3);
  assert.doesNotThrow(() => assertMediaPayloadSize(encodedLimit));
  assert.throws(() => assertMediaPayloadSize(encodedLimit + 1), /Media payload/);
  // The oversized document is intentionally not valid JSON: reaching the size
  // error proves the guard runs before the parser.
  const oversized = "x".repeat(MAX_PROJECT_BYTES + 1);
  assert.throws(() => parseProject(oversized), /too large/);
});

test("seeded fuzz: arbitrary documents fail cleanly or round-trip", async () => {
  let state = 0x2f6e2b1;
  const random = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (items) => items[Math.floor(random() * items.length)];
  const keys = [
    "schemaVersion", "mediaAssets", "audioTracks", "aspectRatio", "fitMode",
    "transitionDuration", "currentTime", "id", "mediaId", "base64", "mimeType",
    "type", "name", "duration", "originalDuration", "startTime", "trimStart",
    "trimEnd", "filter", "hasAudio", "muted", "normalized", "sourceFps",
    "sourceWidth", "sourceHeight",
  ];
  function value(depth) {
    const kind = Math.floor(random() * (depth > 2 ? 6 : 8));
    if (kind === 0) return null;
    if (kind === 1) return random() < 0.5;
    if (kind === 2)
      return pick([
        0, 1, -1, 0.5, 86400, 86400.001, 1e308, -1e308,
        Number.MAX_VALUE, Number.MIN_VALUE, NaN, Infinity,
      ]);
    if (kind === 3)
      return pick([
        "", " ", "clip", "video", "image", "16:9", "9:16", "1:1", "contain",
        "cover", "video/mp4", "audio/mpeg", "dmlkZW8=", "warm", "none", "1",
        "x".repeat(40),
      ]);
    if (kind === 4) return undefined;
    if (kind === 5) return random() * 10;
    if (kind === 6)
      return Array.from({ length: Math.floor(random() * 4) }, () =>
        value(depth + 1),
      );
    const object = {};
    for (let index = 0; index < Math.floor(random() * 6); index += 1)
      object[pick(keys)] = value(depth + 1);
    return object;
  }
  let parsedCount = 0;
  for (let iteration = 0; iteration < 400; iteration += 1) {
    let textValue;
    if (iteration === 0) {
      textValue = legacyText; // a known-good document must always load
    } else if (iteration % 4 === 1) {
      // Structural fuzz: mutate one field of a valid legacy draft.
      const mutated = JSON.parse(legacyText);
      if (random() < 0.5) mutated[pick(keys)] = value(2);
      else {
        const target = pick([mutated.mediaAssets[0], mutated.audioTracks[0]]);
        target[pick(keys)] = value(2);
      }
      textValue = JSON.stringify(mutated);
    } else {
      const generated = JSON.stringify(value(0)) ?? "undefined";
      textValue = iteration % 17 === 0 ? generated.slice(0, 12) : generated;
    }
    let project;
    try {
      project = parseProject(textValue);
    } catch (error) {
      // Only schema rejections belong here; assertion failures must escape.
      if (error instanceof assert.AssertionError) throw error;
      assert.ok(error instanceof Error, `iteration ${iteration}: ${error}`);
      assert.ok(error.message.length > 0, "actionable error message");
      continue;
    }
    parsedCount += 1;
    const saved = await roundTrip(project);
    const reparsed = parseProject(saved);
    assert.equal(await roundTrip(reparsed), saved, "stable round trip");
  }
  assert.ok(parsedCount > 0, "the fuzzer also produces loadable documents");
});


test("the local 23-clip legacy reference migrates deterministically", (t) => {
  const path = "test-data/reference-project.json";
  if (!existsSync(path)) {
    t.skip("local reference draft is absent from this checkout");
    return;
  }
  const textValue = readFileSync(path, "utf8");
  assertProjectSize(Buffer.byteLength(textValue));
  const legacy = JSON.parse(textValue);
  assert.equal(legacy.schemaVersion, undefined, "reference is a legacy draft");
  const migrated = migrateProjectDocument(legacy);
  const { schemaVersion, ...preserved } = migrated;
  assert.equal(schemaVersion, PROJECT_SCHEMA_VERSION);
  // The reference really contains the legacy empty-reference quirk; migration
  // must rebuild exactly those references and preserve everything else.
  assert.equal(legacy.audioTracks[0].mediaId, "");
  const expected = JSON.parse(JSON.stringify(legacy));
  for (const key of ["mediaAssets", "audioTracks"])
    for (const entry of expected[key] || [])
      if (typeof entry.mediaId !== "string" || !entry.mediaId.trim())
        entry.mediaId = entry.id;
  assert.deepEqual(preserved, expected, "migration preserves every field");
  assert.equal(legacy.audioTracks[0].mediaId, "", "input is not mutated");
  const project = parseProject(textValue);
  assert.equal(project.mediaAssets.length, 23);
  assert.equal(project.currentTime, legacy.currentTime ?? 0);
  const payloads = new Map(
    project.sources.map((source) => [source.sourceId, source.base64]),
  );
  project.mediaAssets.forEach((asset, index) => {
    const original = legacy.mediaAssets[index];
    assert.equal(asset.id, original.id);
    assert.equal(asset.startTime, original.startTime);
    assert.equal(asset.duration, original.duration);
    assert.equal(asset.trimStart, original.trimStart ?? 0);
    assert.equal(asset.trimEnd, original.trimEnd ?? 0);
    assert.equal(asset.transitionDuration, original.transitionDuration ?? 0);
    assert.equal(payloads.get(asset.sourceId), original.base64);
  });
});

