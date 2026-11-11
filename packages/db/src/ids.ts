// UUIDv7 composite helper (time-ordered, app-generated). No production data is
// imported in M0; all fixture identifiers are synthetic.
export function uuidv7(now: Date = new Date()): string {
  let hex = now.getTime().toString(16).padStart(12, '0');
  hex = `${hex.slice(0, 8)}-${hex.slice(8, 12)}`;
  const randomBytes = globalThis.crypto.getRandomValues(new Uint8Array(10));
  const randomHex = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const variantNibble = ((parseInt(randomHex.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return `${hex}-7${randomHex.slice(0, 3)}-${variantNibble}${randomHex.slice(4, 7)}-${randomHex.slice(7, 19)}`;
}
