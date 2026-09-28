export interface Artifact { path: string; bytes: number; sha256: string }
export function inspectArtifacts(root: string, expected?: Artifact[]): Promise<Artifact[]>;
export function assertProductModules(ids: string[], root: string): void;
