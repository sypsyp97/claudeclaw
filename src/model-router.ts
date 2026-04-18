import type { AgenticMode } from "./config";

export interface ClassifyResult {
  mode: string;
  model: string;
  confidence: number;
  reasoning: string;
}

const PHRASE_HIT_CONFIDENCE = 0.95;
const BASELINE_CONFIDENCE = 0.6;
const CEILING_CONFIDENCE = 0.9;
const AMBIGUOUS_CONFIDENCE = 0.5;
const QUESTION_BONUS = 0.5;

interface Tally {
  readonly ref: AgenticMode;
  total: number;
}

const toHaystack = (text: string): string => text.toLowerCase().trim();

function findPhraseHit(
  haystack: string,
  registry: AgenticMode[],
): { owner: AgenticMode; literal: string } | undefined {
  for (const candidate of registry) {
    const literals = candidate.phrases;
    if (!literals || literals.length === 0) continue;
    for (const literal of literals) {
      if (haystack.includes(literal)) {
        return { owner: candidate, literal };
      }
    }
  }
  return undefined;
}

function countKeywordHits(haystack: string, needles: string[]): number {
  let hits = 0;
  for (const needle of needles) {
    if (haystack.includes(needle)) hits += 1;
  }
  return hits;
}

function tallyModes(haystack: string, registry: AgenticMode[]): Tally[] {
  const questionCount = (haystack.match(/\?/g) ?? []).length;
  const phraseBonus = questionCount > 0 ? questionCount * QUESTION_BONUS : 0;

  return registry.map((ref) => {
    let total = countKeywordHits(haystack, ref.keywords);
    if (phraseBonus > 0 && ref.phrases && ref.phrases.length > 0) {
      total += phraseBonus;
    }
    return { ref, total };
  });
}

interface RankSnapshot {
  leader: Tally;
  peers: Tally[]; // everything sharing the leader's score
  runnerUpScore: number | null; // best score strictly below the leader, if any
}

function rankTallies(rows: Tally[]): RankSnapshot | null {
  if (rows.length === 0) return null;

  const leader = rows.reduce(
    (best, current) => (current.total > best.total ? current : best),
    rows[0]!,
  );

  const peers: Tally[] = [];
  let runnerUpScore: number | null = null;
  for (const row of rows) {
    if (row.total === leader.total) {
      peers.push(row);
      continue;
    }
    if (runnerUpScore === null || row.total > runnerUpScore) {
      runnerUpScore = row.total;
    }
  }

  return { leader, peers, runnerUpScore };
}

function confidenceForClearWinner(
  leaderScore: number,
  runnerUpScore: number | null,
): number {
  const gap = runnerUpScore === null ? leaderScore : leaderScore - runnerUpScore;
  return Math.min(CEILING_CONFIDENCE, BASELINE_CONFIDENCE + gap * 0.1);
}

function resolveTie(peers: Tally[], preferredName: string): Tally {
  const preferred = peers.find((row) => row.ref.name === preferredName);
  return preferred ?? peers[0]!;
}

function describeWinner(leaderName: string, leaderScore: number, runnerUpScore: number | null): string {
  if (runnerUpScore === null) {
    return `${leaderName} (score ${leaderScore})`;
  }
  return `${leaderName} won with ${leaderScore} (runner-up ${runnerUpScore})`;
}

function describeTie(peers: Tally[], sharedScore: number, chosenName: string): string {
  const namelist = peers.map((row) => row.ref.name).join(" / ");
  return `Tie at score ${sharedScore} among ${namelist}; resolved to ${chosenName}`;
}

function pickFallback(registry: AgenticMode[], preferredName: string): AgenticMode | undefined {
  return registry.find((m) => m.name === preferredName) ?? registry[0];
}

const EMPTY_RESULT: ClassifyResult = {
  mode: "unknown",
  model: "",
  confidence: 0,
  reasoning: "No modes configured",
};

export function classifyTask(
  prompt: string,
  modes: AgenticMode[],
  defaultMode: string,
): ClassifyResult {
  if (modes.length === 0) return { ...EMPTY_RESULT };

  const haystack = toHaystack(prompt);

  const phraseHit = findPhraseHit(haystack, modes);
  if (phraseHit) {
    return {
      mode: phraseHit.owner.name,
      model: phraseHit.owner.model,
      confidence: PHRASE_HIT_CONFIDENCE,
      reasoning: `Phrase hit for "${phraseHit.literal}" routed to ${phraseHit.owner.name}`,
    };
  }

  const ledger = tallyModes(haystack, modes);
  const ranking = rankTallies(ledger);

  if (ranking && ranking.leader.total > 0) {
    const { leader, peers, runnerUpScore } = ranking;

    if (peers.length === 1) {
      return {
        mode: leader.ref.name,
        model: leader.ref.model,
        confidence: confidenceForClearWinner(leader.total, runnerUpScore),
        reasoning: describeWinner(leader.ref.name, leader.total, runnerUpScore),
      };
    }

    const chosen = resolveTie(peers, defaultMode);
    return {
      mode: chosen.ref.name,
      model: chosen.ref.model,
      confidence: BASELINE_CONFIDENCE,
      reasoning: describeTie(peers, leader.total, chosen.ref.name),
    };
  }

  const safety = pickFallback(modes, defaultMode);
  if (!safety) return { ...EMPTY_RESULT };

  return {
    mode: safety.name,
    model: safety.model,
    confidence: AMBIGUOUS_CONFIDENCE,
    reasoning: `Ambiguous input with no keyword hits; defaulting to ${safety.name}`,
  };
}

export function selectModel(
  prompt: string,
  modes: AgenticMode[],
  defaultMode: string,
): { model: string; taskType: string; reasoning: string } {
  const verdict = classifyTask(prompt, modes, defaultMode);
  return {
    model: verdict.model,
    taskType: verdict.mode,
    reasoning: verdict.reasoning,
  };
}
