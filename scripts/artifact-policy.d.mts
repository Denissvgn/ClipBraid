export interface Artifact { path: string; bytes: number; sha256: string }
export function inspectArtifacts(root: string, expected?: Artifact[]): Promise<Artifact[]>;
export function assertProductModules(ids: string[], root: string): void;
export function assertSafeOutputDirectory(root: string): void;
export function assertProductArtifact(name: string, bytes: string | Uint8Array): void;
