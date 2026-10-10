// Browser stand-in for node:crypto so the server's timeline engine runs unchanged in the editor.
export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
export function createHash(): never {
  throw new Error("createHash is not available in the browser");
}
