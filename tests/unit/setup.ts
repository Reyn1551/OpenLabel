// jsdom lacks a few APIs used by the repositories; keep the shim minimal.
if (!globalThis.structuredClone) {
  globalThis.structuredClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
}
