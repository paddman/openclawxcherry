import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(extensionRoot, "src");

async function readSource(name) {
  return await readFile(join(sourceRoot, name), "utf8");
}

async function writeSource(name, content) {
  await writeFile(join(sourceRoot, name), content, "utf8");
}

function replaceAllChecked(source, search, replacement) {
  return source.includes(search) ? source.replaceAll(search, replacement) : source;
}

function addImport(source, anchor, importLine) {
  return source.includes(importLine) ? source : source.replace(anchor, `${anchor}${importLine}`);
}

async function applyControlCharacterMigration(name, anchor = "") {
  let source = await readSource(name);
  const importLine = 'import { sanitizeControlCharacters } from "./text-sanitize.js";\n';
  source = anchor ? addImport(source, anchor, importLine) : `${importLine}${source}`;
  source = source.replace(
    /value\s*\.replace\(\/\[\\u0000-\\u001f\\u007f\]\/gu,\s*" "\)/gu,
    "sanitizeControlCharacters(value)",
  );
  await writeSource(name, source);
}

await writeSource(
  "text-sanitize.ts",
  `/** Replace ASCII control characters with spaces without a control-character regex. */
export function sanitizeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)
      ? " "
      : character;
  }).join("");
}
`,
);

await applyControlCharacterMigration("ingestion.ts");
for (const name of [
  "autonomy.ts",
  "runtime.ts",
  "prediction.ts",
  "consolidation.ts",
  "learning.ts",
]) {
  await applyControlCharacterMigration(name, 'import { dirname, join } from "node:path";\n');
}

{
  let source = await readSource("policy.ts");
  source = replaceAllChecked(
    source,
    '    case "low":\n    default:\n      return 0;',
    "    default:\n      return 0;",
  );
  await writeSource("policy.ts", source);
}

{
  let source = await readSource("ingestion.ts");
  source = replaceAllChecked(
    source,
    '    case "generic":\n    default:\n      return normalizeGeneric(envelope);',
    "    default:\n      return normalizeGeneric(envelope);",
  );
  await writeSource("ingestion.ts", source);
}

{
  let source = await readSource("autonomy.ts");
  source = replaceAllChecked(
    source,
    '    case "low":\n    default:\n      return 0.16;',
    "    default:\n      return 0.16;",
  );
  source = source.replaceAll(
    ".sort((left, right) => right.createdAt - left.createdAt)",
    ".toSorted((left, right) => right.createdAt - left.createdAt)",
  );
  await writeSource("autonomy.ts", source);
}

{
  let source = await readSource("runtime.ts");
  source = replaceAllChecked(
    source,
    '    case "text":\n    default:\n      return 0.56;',
    "    default:\n      return 0.56;",
  );
  source = replaceAllChecked(
    source,
    "return this.getSession(sessionKey).goals.map((goal) => ({ ...goal }));",
    "return this.getSession(sessionKey).goals.map((goal) => structuredClone(goal));",
  );
  source = source.replaceAll(
    ".sort((left, right) => right.priority - left.priority)",
    ".toSorted((left, right) => right.priority - left.priority)",
  );
  source = source.replaceAll(
    ".sort((left, right) => right.score - left.score || right.timestamp - left.timestamp)",
    ".toSorted((left, right) => right.score - left.score || right.timestamp - left.timestamp)",
  );
  source = source.replaceAll(
    ".map((goal) => ({ ...goal }));",
    ".map((goal) => structuredClone(goal));",
  );
  source = source.replaceAll(
    ".map((item) => ({ ...item }));",
    ".map((item) => structuredClone(item));",
  );
  source = replaceAllChecked(
    source,
    "session.episodicMemory.slice(-10).map((episode) => ({ ...episode }))",
    "session.episodicMemory.slice(-10).map((episode) => structuredClone(episode))",
  );
  source = replaceAllChecked(
    source,
    `sessions: [...this.sessions.values()].map((session) => ({
        ...structuredClone(session),
        lastPersistedAt: savedAt,
      }))`,
    `sessions: [...this.sessions.values()].map((session) =>
        Object.assign(structuredClone(session), { lastPersistedAt: savedAt }),
      )`,
  );
  await writeSource("runtime.ts", source);
}

{
  let source = await readSource("tracked-runtime.ts");
  source = replaceAllChecked(
    source,
    `  constructor(config: CognitiveConfig) {
    super(config);
  }

`,
    "",
  );
  source = replaceAllChecked(source, "  CognitiveConfig,\n", "");
  source = replaceAllChecked(
    source,
    "return [...this.knownSessionKeys].sort((left, right) => left.localeCompare(right));",
    "return [...this.knownSessionKeys].toSorted((left, right) => left.localeCompare(right));",
  );
  await writeSource("tracked-runtime.ts", source);
}

{
  let source = await readSource("attention-schema.ts");
  source = replaceAllChecked(
    source,
    'import type { Observation, SessionCognitiveState, WorkspaceItem } from "./types.js";',
    `import type {
  NcaFieldSnapshot,
  Observation,
  SessionCognitiveState,
  WorkspaceItem,
} from "./types.js";`,
  );
  source = replaceAllChecked(
    source,
    "type EnrichedWorkspaceItem = {",
    "type AttentionState = SessionCognitiveState & { fieldSnapshot: NcaFieldSnapshot };\n\ntype EnrichedWorkspaceItem = {",
  );
  source = source.replaceAll("state: SessionCognitiveState", "state: AttentionState");
  source = source.replaceAll(
    "].sort((left, right) => right.value - left.value);",
    "].toSorted((left, right) => right.value - left.value);",
  );
  source = source.replaceAll(
    ".sort((left, right) => right.score - left.score)",
    ".toSorted((left, right) => right.score - left.score)",
  );
  await writeSource("attention-schema.ts", source);
}

{
  let source = await readSource("prediction.ts");
  source = source.replaceAll(
    ".sort((left, right) => right.createdAt - left.createdAt)",
    ".toSorted((left, right) => right.createdAt - left.createdAt)",
  );
  await writeSource("prediction.ts", source);
}

{
  let source = await readSource("consolidation.ts");
  source = replaceAllChecked(
    source,
    '    case "fact":\n    default:\n      return `Observed fact: ${summary}`;',
    "    default:\n      return `Observed fact: ${summary}`;",
  );
  source = replaceAllChecked(
    source,
    "return { ...structuredClone(memory), score, similarity: semanticSimilarity };",
    `return Object.assign(structuredClone(memory), {
          score,
          similarity: semanticSimilarity,
        });`,
  );
  source = source.replaceAll(
    ".sort((left, right) => right.score - left.score)",
    ".toSorted((left, right) => right.score - left.score)",
  );
  source = source.replaceAll(
    ".sort((left, right) => memoryScore(right) - memoryScore(left))",
    ".toSorted((left, right) => memoryScore(right) - memoryScore(left))",
  );
  source = replaceAllChecked(
    source,
    "    const tags = [episode.kind, categoryForEpisode(episode)];",
    "    const tags: string[] = [episode.kind, categoryForEpisode(episode)];",
  );
  await writeSource("consolidation.ts", source);
}

{
  let source = await readSource("learning.ts");
  source = replaceAllChecked(source, "        ...(input.data ?? {}),", "        ...input.data,");
  source = source.replaceAll(".sort(", ".toSorted(");
  await writeSource("learning.ts", source);
}

console.log("Applied Cherry Cognitive lint and type-safety migration.");
