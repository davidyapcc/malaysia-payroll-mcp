// Shared fakes for the eval tests. No test in this folder calls a paid API.
import type { ControlEvaluation, SeededControl } from "../../evals/controls.ts";
import {
  type AmountParty,
  type CaseEvaluation,
  type EvalCase,
  headlineAmounts,
  type Layer1Result,
  type RubricScore,
} from "../../evals/grading.ts";
import type {
  LlmClient,
  MessagesCreateParams,
  MessagesResponseLike,
} from "../../evals/providers.ts";

const JUDGE_CASE_ID_RE = /^Case ID: (\S+)$/m;
const CLEAN_DIMENSION_SCORE = 5;
const CAUGHT_DIMENSION_SCORE = 2;
const REFUSAL_ANSWER =
  "Foreign workers cannot opt out of SKBBK (Lindung 24 Jam). Not tax advice; fixed salaries only.";

/** Extracts the case or control ID from a judge user message. */
export function judgeCaseId(userMessage: string): string {
  const id = JUDGE_CASE_ID_RE.exec(userMessage)?.[1];
  if (id === undefined) throw new Error("Judge message has no Case ID line.");
  return id;
}

/** Judge JSON that scores every dimension at 5 with no hallucination. */
export function cleanVerdictJson(): string {
  return JSON.stringify({
    citationFaithfulness: CLEAN_DIMENSION_SCORE,
    completeness: CLEAN_DIMENSION_SCORE,
    clarity: CLEAN_DIMENSION_SCORE,
    hallucinatedCitation: false,
    rationale: "Faithful, complete and clear.",
  });
}

/** Judge JSON that catches a seeded control: flags the hallucination, or scores the dimension low. */
export function catchingVerdictJson(control: SeededControl): string {
  const { expectation } = control;
  if (expectation.kind === "hallucination") {
    return JSON.stringify({
      citationFaithfulness: CAUGHT_DIMENSION_SCORE,
      completeness: CLEAN_DIMENSION_SCORE,
      clarity: CLEAN_DIMENSION_SCORE,
      hallucinatedCitation: true,
      rationale: "Invented statute section not in the tool output.",
    });
  }
  const score = (dimension: string) =>
    dimension === expectation.dimension ? CAUGHT_DIMENSION_SCORE : CLEAN_DIMENSION_SCORE;
  return JSON.stringify({
    citationFaithfulness: score("citationFaithfulness"),
    completeness: score("completeness"),
    clarity: score("clarity"),
    hallucinatedCitation: false,
    rationale: "Contradicts the tool output.",
  });
}

/** A judge that catches every seeded control and scores everything else cleanly. */
export function catchingJudgeReply(controls: readonly SeededControl[]): (caseId: string) => string {
  return (caseId) => {
    const control = controls.find((c) => c.id === caseId);
    return control === undefined ? cleanVerdictJson() : catchingVerdictJson(control);
  };
}

function textResponse(text: string): MessagesResponseLike {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}

function labelFor(party: AmountParty | null): string {
  if (party === "employer") return "Employer";
  return party === "employee" ? "Employee" : "Amount";
}

/** The agent's correct final answer for a case: every headline figure with its party, or the refusal. */
export function agentAnswer(evalCase: EvalCase): string {
  if (evalCase.expectedError !== undefined) return REFUSAL_ANSWER;
  const lines = headlineAmounts(evalCase).map(
    (headline) => `${labelFor(headline.party)}: RM${headline.amount.toFixed(2)}`,
  );
  return [
    ...lines,
    "Cited from official rate table. Not tax or legal advice; fixed monthly salaries only.",
  ].join("\n");
}

/**
 * A fake LLM. The agent calls the expected tool once and then answers correctly. The judge replies
 * with `judgeReply(caseId)`, so tests choose whether the judge is honest or broken.
 */
export function createFakeLlm(params: {
  readonly evalCases: readonly EvalCase[];
  readonly judgeReply: (caseId: string) => string;
}): LlmClient {
  const casesByPrompt = new Map(params.evalCases.map((c) => [c.prompt, c]));
  return {
    messages: {
      async create(request: MessagesCreateParams): Promise<MessagesResponseLike> {
        if (request.tools === undefined) {
          const message = request.messages[0]?.content;
          if (typeof message !== "string") throw new Error("Judge message must be a string.");
          return textResponse(params.judgeReply(judgeCaseId(message)));
        }
        const prompt = request.messages[0]?.content;
        const evalCase = typeof prompt === "string" ? casesByPrompt.get(prompt) : undefined;
        if (evalCase === undefined) throw new Error(`Unknown prompt: ${String(prompt)}`);
        if (request.messages.length === 1) {
          return {
            stop_reason: "tool_use",
            content: [
              { type: "text", text: "Checking the tool." },
              {
                type: "tool_use",
                id: `call_${evalCase.id}`,
                name: evalCase.expectedTool,
                input: evalCase.expectedInput,
              },
            ],
          };
        }
        return textResponse(agentAnswer(evalCase));
      },
    },
  };
}

const PASSING_LAYER1: Layer1Result = {
  isPassed: true,
  hasExpectedTool: true,
  hasMatchingArgs: true,
  hasMatchingToolOutput: true,
  hasValidProse: true,
  missingAmounts: [],
  failureReasons: [],
};

const CLEAN_RUBRIC: RubricScore = {
  citationFaithfulness: CLEAN_DIMENSION_SCORE,
  completeness: CLEAN_DIMENSION_SCORE,
  clarity: CLEAN_DIMENSION_SCORE,
  hasHallucinatedCitation: false,
  rationale: "ok",
};

/** Builds a case result with passing defaults; override only the fields a test cares about. */
export function makeCaseEvaluation(
  overrides: Partial<CaseEvaluation> & { readonly id: string },
): CaseEvaluation {
  return {
    prompt: "p",
    expectedTool: "calculate_epf",
    isMustPass: false,
    toolCalls: [],
    finalAnswer: "",
    layer1: PASSING_LAYER1,
    layer2: CLEAN_RUBRIC,
    judgeError: null,
    agentError: null,
    durationMs: 1,
    ...overrides,
  };
}

/** Builds a control result with a caught default; override only what a test needs. */
export function makeControlEvaluation(
  overrides: Partial<ControlEvaluation> & { readonly id: string },
): ControlEvaluation {
  return {
    description: "control",
    expectation: { kind: "hallucination" },
    judgment: CLEAN_RUBRIC,
    judgeError: null,
    isCaught: true,
    ...overrides,
  };
}

/** Builds a Layer 1 result that passes unless overridden. */
export function makeLayer1(overrides: Partial<Layer1Result>): Layer1Result {
  return { ...PASSING_LAYER1, ...overrides };
}
