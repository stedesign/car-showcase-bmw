import { serializeProject, type Project } from './project';

const DEFAULT_LIMIT = 80;

export type ProjectHistory = {
  /** Record a new present state. No-op if identical to current present. */
  push: (snapshot: Project) => boolean;
  undo: () => Project | null;
  redo: () => Project | null;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Reset stacks around a new present (import / new project). */
  reset: (present: Project) => void;
};

export function createProjectHistory(
  initial: Project,
  limit = DEFAULT_LIMIT,
): ProjectHistory {
  let present = structuredClone(initial);
  let presentKey = serializeProject(present);
  const past: { project: Project; key: string }[] = [];
  const future: { project: Project; key: string }[] = [];

  return {
    push(snapshot) {
      const next = structuredClone(snapshot);
      const key = serializeProject(next);
      if (key === presentKey) return false;
      past.push({ project: present, key: presentKey });
      if (past.length > limit) past.shift();
      present = next;
      presentKey = key;
      future.length = 0;
      return true;
    },
    undo() {
      const prev = past.pop();
      if (!prev) return null;
      future.push({ project: present, key: presentKey });
      present = prev.project;
      presentKey = prev.key;
      return structuredClone(present);
    },
    redo() {
      const next = future.pop();
      if (!next) return null;
      past.push({ project: present, key: presentKey });
      present = next.project;
      presentKey = next.key;
      return structuredClone(present);
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    reset(next) {
      present = structuredClone(next);
      presentKey = serializeProject(present);
      past.length = 0;
      future.length = 0;
    },
  };
}
