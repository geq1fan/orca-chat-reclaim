// The worker runs in Node, but Orca's typings keep Node's out of the plugin project and this
// plugin has no dependencies. These three modules are declared only as far as it uses them.
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { maxBuffer?: number; env?: Record<string, string | undefined> },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): unknown
}

declare module 'node:os' {
  export function homedir(): string
}

declare module 'node:path' {
  export function join(...parts: string[]): string
}

declare const process: {
  readonly pid: number
  readonly env: Record<string, string | undefined>
  kill(pid: number, signal?: string | number): boolean
}
