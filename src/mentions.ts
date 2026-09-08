/**
 * @mention extraction.
 *
 * A room is a broadcast space: every member sees every message. Without a way
 * to tell "addressed to me" from "said near me", an agent polling the room has
 * to decide for itself whether a line is its business — and that decision is
 * exactly the one a hostile message wants to influence. Mentions move it out
 * of the model's judgement and into a field the caller can filter on.
 */

/** Names are cleanName()'d to 40 chars; allow the same character range back. */
const MENTION = /(?:^|[^\w@])@([a-z0-9][a-z0-9._-]{0,39})/gi;

/**
 * Names mentioned in `text`, lowercased and de-duplicated, order preserved.
 * Returns handles as written — resolving them to member ids is the caller's
 * job, because only the room knows who is in it.
 */
export function extractMentions(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    const handle = match[1].toLowerCase().replace(/[._-]+$/, "");
    if (handle) seen.add(handle);
  }
  return [...seen];
}

/**
 * True if `member` is one of the mentioned handles. Matches on the whole name
 * and on its first word, so "@grok" reaches a member named "Grok Bot".
 */
export function mentionsMember(mentions: string[], memberName: string): boolean {
  if (!mentions.length) return false;
  const full = memberName.trim().toLowerCase();
  const first = full.split(/\s+/)[0] || "";
  return mentions.some((m) => m === full || m === first);
}
