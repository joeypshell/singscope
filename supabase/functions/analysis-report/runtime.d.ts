declare module '@supabase/supabase-js' {
  export function createClient(url: string, key: string, options?: unknown): unknown
}

declare const Deno: {
  readonly env: {
    get(name: string): string | undefined
  }
  serve(handler: (request: Request) => Response | Promise<Response>): void
}
