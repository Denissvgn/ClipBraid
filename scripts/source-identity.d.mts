export function sourceIdentity(root?: string): { inputs: { path: string; sha256: string }[]; sha256: string };
export function repositoryState(root?: string): { commit: string | null; dirty: boolean | null };
