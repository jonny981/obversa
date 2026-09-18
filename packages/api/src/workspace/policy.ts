

export type WorkspaceMode = 'none' | 'read' | 'write';

export interface NodeWorkspacePolicy {
  readonly mode: WorkspaceMode;
  readonly directory: string | null;
  readonly allowedPaths: readonly string[];
}
