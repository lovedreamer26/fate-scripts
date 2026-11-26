export class ScriptTextError extends Error {
  input: unknown;
}
export function parseScriptText(input: string, options?: { raw?: boolean }): { metadata: Record<string, unknown>; code: string };
export function formatScriptText(metadata: Record<string, unknown>, code: string): string;
