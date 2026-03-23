export interface EvaluationResult {
  score: number;
  passed: boolean;
  feedback: string;
}

export interface EvaluationOptions {
  passingScore?: number;
}

const DEFAULT_PASSING_SCORE = 0.5;

export namespace EvaluationGate {
  export function evaluate(
    actualOutput: string,
    expectedOutput: string,
    options?: EvaluationOptions,
  ): EvaluationResult {
    const passingScore = options?.passingScore ?? DEFAULT_PASSING_SCORE;

    if (!actualOutput || actualOutput.trim() === "") {
      return {
        score: 0,
        passed: false,
        feedback: "No output produced",
      };
    }

    if (!expectedOutput || expectedOutput.trim() === "") {
      return {
        score: 1,
        passed: true,
        feedback: "No expected output specified — accepting any output",
      };
    }

    const score = computeSimilarityScore(actualOutput, expectedOutput);
    const passed = score >= passingScore;

    return {
      score,
      passed,
      feedback: passed
        ? `Output meets quality threshold (score: ${score.toFixed(2)})`
        : `Output below quality threshold (score: ${score.toFixed(2)}, required: ${passingScore})`,
    };
  }
}

function computeSimilarityScore(actual: string, expected: string): number {
  const actualLower = actual.toLowerCase();
  const expectedLower = expected.toLowerCase();

  if (actualLower === expectedLower) return 1;

  const expectedWords = tokenize(expectedLower);
  if (expectedWords.length === 0) return 1;

  const actualWords = new Set(tokenize(actualLower));
  let matchCount = 0;
  for (const word of expectedWords) {
    if (actualWords.has(word)) matchCount++;
  }

  return matchCount / expectedWords.length;
}

function tokenize(text: string): string[] {
  return text
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}
