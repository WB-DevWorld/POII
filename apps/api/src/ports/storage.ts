// Storage port for original bytes and generated artifacts (BUILD-BASELINE.md §6).
export interface StoragePort {
  readonly name: string;
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Null when the key does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/;

export function assertStorageKey(key: string): void {
  if (!KEY.test(key) || key.split('/').some(part => part === '..' || part === '.')) {
    throw new Error(`Invalid storage key: ${key}`);
  }
}
