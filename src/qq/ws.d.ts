declare module 'ws' {
  export default class WebSocket {
    constructor(url: string, options?: { headers?: Record<string, string> });
    on(event: 'open' | 'close', listener: () => void): this;
    on(event: 'message', listener: (data: unknown) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    close(): void;
  }
}
