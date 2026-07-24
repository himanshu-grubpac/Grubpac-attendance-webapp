const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%&*';
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;

function pick(chars) {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return chars[array[0] % chars.length];
}

function shuffle(values) {
  const arr = [...values];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    const j = array[0] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Generates a password that satisfies shared passwordSchema (8+ chars, upper, lower, number). */
export function generatePassword(length = 12) {
  const size = Math.max(8, Math.min(length, 128));
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS)];
  while (chars.length < size) {
    chars.push(pick(ALL));
  }
  return shuffle(chars).join('');
}
