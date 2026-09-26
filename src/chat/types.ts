export interface MediaEntry extends Record<string, unknown> {
  kind: string;
  url?: string;
}

export interface DigestRecord extends Record<string, unknown> {
  from: number;
  to: number;
  count: number;
  summary?: string;
}

export interface ChatMessage extends Record<string, unknown> {
  id: number;
  ts: number;
  text: string;
  senderId: string;
  senderName: string;
  self: boolean;
  read: boolean;
  mid?: string | number | null;
  kind?: string;
  media?: MediaEntry[];
  digest?: DigestRecord;
}

export interface SessionRecord extends Record<string, unknown> { id: string }
export interface MemoryMember extends Record<string, unknown> { id?: string; name?: string }
