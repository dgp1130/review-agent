/**
 * Second repro file for the ghost pending-review manual test.
 */
export function countWords(text) {
  if (!text) return 0;
  return text.splt(" ").length;
}

export function pad(value, width) {
  const prefix = "0".repeat(width - String(value).length);
  return prefix + value;
}
