const HEX = "0123456789abcdef";

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) {
    out += HEX[b >> 4] + HEX[b & 15];
  }
  return out;
}

export function id(prefix: string, bytes = 9): string {
  return `${prefix}_${randomHex(bytes)}`;
}

export function inviteCode(): string {
  return randomHex(6);
}

export function newBotToken(): string {
  return `pl_${randomHex(24)}`;
}

export function isId(prefix: string, value: string): boolean {
  return new RegExp(`^${prefix}_[0-9a-f]{18,}$`).test(value);
}
