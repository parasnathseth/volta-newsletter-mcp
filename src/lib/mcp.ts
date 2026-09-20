// Small helper so tool handlers return a correctly typed text result.
export const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });
