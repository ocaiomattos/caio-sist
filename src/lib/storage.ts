import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface MediaStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const KEY_RE = /^[a-f0-9-]{36}\.(jpg|webp)$/;

/** Armazena arquivos com chaves geradas pelo servidor; nomes enviados pelo cliente nunca viram caminhos. */
export class DiskStorage implements MediaStorage {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    if (!KEY_RE.test(key)) throw new Error('chave de armazenamento inválida');
    return join(this.dir, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(key), data, { flag: 'wx', mode: 0o600 });
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export class MemoryStorage implements MediaStorage {
  readonly files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.files.set(key, data);
  }
  async get(key: string) {
    return this.files.get(key) ?? null;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
}
