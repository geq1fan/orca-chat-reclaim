/** A host error, an exec error or anything thrown: the message a person should read. */
export function messageOf(error: unknown): string {
  const failure = error as { message?: unknown }
  return typeof failure.message === 'string' ? failure.message : String(error)
}