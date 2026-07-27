/** Replace ASCII control characters with spaces without a control-character regex. */
export function sanitizeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f) ? " " : character;
  }).join("");
}
