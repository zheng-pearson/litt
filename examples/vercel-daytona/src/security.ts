import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const randomToken = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function equalSecret(actual: string | null, expected: string): boolean {
  return (
    actual !== null &&
    timingSafeEqual(Buffer.from(digest(actual)), Buffer.from(digest(expected)))
  );
}

export class Vault {
  constructor(private key: string) {}
  seal(value: unknown, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(this.key, "hex"),
      iv,
    );
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      "base64url",
    );
  }
  open<T>(value: string, context: string): T {
    const bytes = Buffer.from(value, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(this.key, "hex"),
      bytes.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString(),
    );
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function limitedBody(
  req: Request,
  limit = 256 * 1024,
): Promise<Buffer> {
  const reader = req.body?.getReader();
  if (!reader) {
    throw new HttpError(400, "Missing request body");
  }
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const part = await reader.read();
    if (part.done) {
      break;
    }
    bytes += part.value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new HttpError(413, "Request too large");
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks);
}
export async function limitedJson(req: Request, limit = 256 * 1024): Promise<unknown> {
  const body = await limitedBody(req, limit);
  try {
    return JSON.parse(body.toString());
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
