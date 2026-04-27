/**
 * LLM disambig client. Converts ambiguous bet phrasing into a canonical
 * sentence (the "outcome contract") that both parties EIP-712 sign before
 * the bet is created on-chain.
 *
 * Verbatim quote is sacred: we NEVER edit the user's original phrasing.
 * The LLM emits a separate single-sentence canonical that captures the
 * unambiguous winning condition. Both are stored in DB + shown in embeds.
 *
 * For now this is a single-shot proposal. The conversational refinement
 * loop (s-disambig-chat issue) wraps this with a private-thread flow on a
 * later iteration.
 */
import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.js";

let _client: Anthropic | null = null;
function client(): Anthropic | null {
  if (_client) return _client;
  if (!env.ANTHROPIC_API_KEY) return null;
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

const SYSTEM_PROMPT = `You are the disambig step of cozy-bet, a peer-to-peer wagering app.

The user states a bet in plain language. Your job: produce ONE canonical sentence that unambiguously specifies the winning condition. The sentence must:

- Preserve EVERYTHING the user said (parties, action, time/place if given).
- Add only the minimum facts a neutral observer would need to decide who won. Examples: full team names, exact game date, "official box score" as the source of truth, what counts as overtime.
- Be a single sentence. No bullet points, no markdown.
- If the user's phrasing is hopelessly ambiguous (e.g. "I bet I'll feel happy"), respond ONLY with the literal token UNRESOLVABLE — nothing else.
- If the user references a specific dated event but the date is implicit (e.g. "tonight"), keep "tonight" but also note the explicit calendar date.
- Do NOT add bet amounts, parties' real names, or any context the user didn't provide.
- Do NOT moralize, hedge, or add disclaimers.

Output: just the canonical sentence (or UNRESOLVABLE).`;

export type DisambigResult =
  | { kind: "ok"; canonical: string }
  | { kind: "unresolvable"; reason: string }
  | { kind: "skipped"; canonical: string }; // LLM not configured — passthrough

/**
 * Run the disambig step. Returns a `kind` discriminator:
 * - `ok`: canonical sentence is the LLM's clarified version
 * - `unresolvable`: bot should reject the bet with a "please reword" message
 * - `skipped`: ANTHROPIC_API_KEY not set; canonical = user input verbatim
 */
export async function disambig(args: {
  userPhrase: string;
  challengerTag: string;
  accepterTag: string;
  todayIso: string;
}): Promise<DisambigResult> {
  const c = client();
  if (!c) {
    return { kind: "skipped", canonical: args.userPhrase };
  }
  const userMessage = [
    `User phrase: ${JSON.stringify(args.userPhrase)}`,
    `Challenger: ${args.challengerTag}`,
    `Accepter: ${args.accepterTag}`,
    `Today: ${args.todayIso}`,
    "",
    "Output: the canonical sentence, or UNRESOLVABLE.",
  ].join("\n");
  const resp = await c.messages.create({
    model: env.DISAMBIG_MODEL,
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  // ContentBlock union has multiple variants; only `text` blocks have a .text field.
  const text = resp.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  if (text === "UNRESOLVABLE" || text.startsWith("UNRESOLVABLE")) {
    return { kind: "unresolvable", reason: text };
  }
  return { kind: "ok", canonical: text };
}

// termsHashOf moved to ./terms.js so test files can import it without
// pulling in the Anthropic client + env validation. Re-export here for
// callers that already import from llm.js.
export { termsHashOf } from "./terms.js";
