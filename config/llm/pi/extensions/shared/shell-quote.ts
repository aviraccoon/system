/**
 * Shell quoting for commands handed to agents or users to run verbatim.
 * Single quotes are the only safe embedding for arbitrary strings — double
 * quotes still expand $, backticks, and escapes inside.
 */

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
