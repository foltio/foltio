import { randomBytes, createHash } from "node:crypto";

const alphabet = "0123456789abcdefghijkmnopqrstuvwxyz";
export function rid(n = 12) {
  const bytes = randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}
// Short, prefixed, opaque handles: prj_ ast_ job_ qt_ itm_ trk_ trn_ mkr_ rnd_ …
export const id = (prefix, n = 12) => `${prefix}_${rid(n)}`;
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
