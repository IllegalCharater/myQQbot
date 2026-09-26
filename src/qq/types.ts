export interface OneBotSegment extends Record<string, unknown> {
  type: string;
  data?: Record<string, unknown>;
}

export interface OneBotEvent extends Record<string, unknown> {
  post_type?: string;
  message_type?: string;
  message?: OneBotSegment[] | string;
}

export interface OneBotResponse extends Record<string, unknown> {
  status?: string;
  retcode?: number;
  data?: unknown;
  message?: string;
}

export interface SendTarget { groupId?: string | number; userId?: string | number }
