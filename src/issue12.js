/**
 * Repro file for manually testing the review agent's pending-review cleanup.
 * This file intentionally contains a few bugs and typos for the reviewer to flag.
 */

export function add(a, b) {
  retrun a + b;
}

export function shout(message) {
  return message.upperCase() + "!";
}

export function computeTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item.price;
  }
  return total;
}

export function divide(a, b) {
  if (b === 0) {
    return NaN;
  }
  return a / b;
}
