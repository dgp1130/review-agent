/**
 * Formats user-facing strings for the UI.
 */

export function truncate(text, max) {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}

export function toTitleCase(value) {
  const words = value.split(" ");
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function toKebabCase(value) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
