// Seeded bad answers that the Layer 2 judge must catch on every live run (ADR 0004).
import { readFileSync } from "node:fs";
import * as z from "zod";
import type { RecordedToolCall, RubricScore } from "./grading.ts";

/** A dimension control is caught when the judge scores that dimension at or below this value. */
export const CONTROL_MAX_DIMENSION_SCORE = 3;

const RUBRIC_DIMENSIONS = ["citationFaithfulness", "completeness", "clarity"] as const;

const recordedToolCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  isError: z.boolean(),
  textContent: z.string(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

const expectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hallucination") }),
  z.object({ kind: z.literal("dimension"), dimension: z.enum(RUBRIC_DIMENSIONS) }),
]);

const seededControlSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().trim().min(1),
  toolCalls: z.array(recordedToolCallSchema).min(1),
  finalAnswer: z.string().min(1),
  expectation: expectationSchema,
});

const seededControlsFileSchema = z.array(seededControlSchema).min(1);

type ParsedSeededControl = z.infer<typeof seededControlSchema>;

export type SeededControl = Omit<ParsedSeededControl, "toolCalls"> & {
  readonly toolCalls: readonly RecordedToolCall[];
};

function toRecordedToolCall(call: ParsedSeededControl["toolCalls"][number]): RecordedToolCall {
  const { structuredContent, ...rest } = call;
  return structuredContent === undefined ? rest : { ...rest, structuredContent };
}

export interface ControlEvaluation {
  readonly id: string;
  readonly description: string;
  readonly expectation: SeededControl["expectation"];
  readonly judgment: RubricScore | null;
  readonly judgeError: string | null;
  readonly isCaught: boolean;
}

/** Validates the seeded controls file and rejects duplicate control IDs. */
export function parseSeededControls(jsonText: string): SeededControl[] {
  const parsed: unknown = JSON.parse(jsonText);
  const result = seededControlsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid seeded controls file: ${result.error.message}`);
  }
  const ids = result.data.map((control) => control.id);
  const duplicateId = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicateId !== undefined) {
    throw new Error(`Duplicate seeded control ID "${duplicateId}".`);
  }
  return result.data.map((control) => ({
    ...control,
    toolCalls: control.toolCalls.map(toRecordedToolCall),
  }));
}

/** Loads and validates evals/controls.json. */
export function loadSeededControls(
  controlsUrl = new URL("./controls.json", import.meta.url),
): SeededControl[] {
  return parseSeededControls(readFileSync(controlsUrl, "utf8"));
}

/** True when the judge's verdict meets the control's expectation (it caught the bad answer). */
export function isControlCaught(control: SeededControl, judgment: RubricScore): boolean {
  const { expectation } = control;
  if (expectation.kind === "hallucination") return judgment.hasHallucinatedCitation;
  return judgment[expectation.dimension] <= CONTROL_MAX_DIMENSION_SCORE;
}

/** Describes what the judge must do for a control, for the Scorecard. */
export function describeExpectation(expectation: SeededControl["expectation"]): string {
  if (expectation.kind === "hallucination") return "Flag a hallucinated citation";
  return `Score ${expectation.dimension} at or below ${CONTROL_MAX_DIMENSION_SCORE}`;
}
