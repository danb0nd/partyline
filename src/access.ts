import type { Actor } from "./types";

/** Creator (human or bot) or any human member. Rooms are disposable. */
export function canDeleteRoom(
  actor: Actor,
  room: { created_by: string },
  isMember: boolean,
): boolean {
  if (!isMember) return false;
  if (actor.id === room.created_by) return true;
  return actor.kind === "human";
}

export function canInvite(actor: Actor, isMember: boolean): boolean {
  return isMember && (actor.kind === "human" || actor.role === "owner");
}
