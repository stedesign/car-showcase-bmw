import { rememberFontSource, storedFontSource } from './fonts';
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

/**
 * Undo snapshots drop font file bytes. The live project and the font
 * registry keep the data URL, so a title edit does not clone the file.
 */
function projectForHistory(project: Project): Project {
  for (const font of project.fonts ?? []) {
    if (font.source) rememberFontSource(font.id, font.source);
  }
  return structuredClone({
    ...project,
    fonts: (project.fonts ?? []).map((font) => ({ ...font, source: '' })),
  });
}

function projectFromHistory(project: Project): Project {
  const next = structuredClone(project);
  for (const font of next.fonts ?? []) {
    if (font.source) {
      rememberFontSource(font.id, font.source);
      continue;
    }
    const source = storedFontSource(font.id);
    if (source) font.source = source;
  }
  return next;
}

export function createProjectHistory(
  initial: Project,
  limit = DEFAULT_LIMIT,
): ProjectHistory {
  let present = projectForHistory(initial);
  let presentKey = serializeProject(present);
  const past: { project: Project; key: string }[] = [];
  const future: { project: Project; key: string }[] = [];

  return {
    push(snapshot) {
      const next = projectForHistory(snapshot);
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
      return projectFromHistory(present);
    },
    redo() {
      const next = future.pop();
      if (!next) return null;
      past.push({ project: present, key: presentKey });
      present = next.project;
      presentKey = next.key;
      return projectFromHistory(present);
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    reset(next) {
      present = projectForHistory(next);
      presentKey = serializeProject(present);
      past.length = 0;
      future.length = 0;
    },
  };
}
