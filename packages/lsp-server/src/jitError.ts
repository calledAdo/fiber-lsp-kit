/** Error raised by the JIT service and its mode strategies. Its own module so both can throw it without a cycle. */
export class JitError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "JitError";
  }
}
