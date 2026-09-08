export interface Env {
  DB: D1Database;
  ROOMS: DurableObjectNamespace;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  APP_NAME?: string;
  APP_URL?: string;
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
  DEV_AUTH?: string;
}

export type ActorKind = "human" | "bot";

export interface Actor {
  id: string;
  kind: ActorKind;
  name: string;
  email?: string;
  role: string;
}

export interface Attachment {
  key: string;
  name: string;
  content_type: string;
  size: number;
  kind: "image" | "file";
}

export interface Message {
  id: string;
  room_id: string;
  author_id: string;
  author_name: string;
  author_kind: ActorKind;
  author_role: string;
  text: string;
  attachments: Attachment[];
  created_at: number;
  /** Handles found in `text`, lowercased. Derived, never client-supplied. */
  mentions: string[];
  /** Whether `mentions` names the actor this copy was rendered for. */
  mentions_you?: boolean;
}

export interface RoomRow {
  id: string;
  name: string;
  invite_code: string;
  created_by: string;
  created_at: number;
}

export interface Member {
  id: string;
  kind: ActorKind;
  name: string;
  role: string;
  joined_at: number;
  online?: boolean;
}
