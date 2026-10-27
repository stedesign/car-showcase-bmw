/** Modal: replace the whole project, or merge selected scenes from an import. */

export type ImportSceneOption = {
  id: string;
  name: string;
  duration: number;
};

export type ImportProjectChoice =
  | { mode: 'cancel' }
  | { mode: 'replace' }
  | { mode: 'merge'; sceneIds: string[]; addToMaster: boolean };

export type ImportProjectDialogOptions = {
  projectName: string;
  scenes: ImportSceneOption[];
};

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s';
  const rounded = Math.round(seconds * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}s` : `${rounded.toFixed(1)}s`;
}

export function showImportProjectDialog(
  opts: ImportProjectDialogOptions,
): Promise<ImportProjectChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ed-import-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'ed-import-title');

    const panel = document.createElement('div');
    panel.className = 'ed-import-panel';

    const title = document.createElement('h2');
    title.id = 'ed-import-title';
    title.className = 'ed-import-title';
    title.textContent = 'Import project';

    const summary = document.createElement('p');
    summary.className = 'ed-import-summary';
    const sceneLabel = opts.scenes.length === 1 ? '1 scene' : `${opts.scenes.length} scenes`;
    summary.textContent = `“${opts.projectName || 'Untitled'}” · ${sceneLabel}`;

    const modeReplace = document.createElement('label');
    modeReplace.className = 'ed-import-mode';
    const replaceRadio = document.createElement('input');
    replaceRadio.type = 'radio';
    replaceRadio.name = 'ed-import-mode';
    replaceRadio.value = 'replace';
    replaceRadio.checked = true;
    const replaceCopy = document.createElement('span');
    replaceCopy.innerHTML =
      '<strong>Replace</strong> current project with this file';
    modeReplace.append(replaceRadio, replaceCopy);

    const modeMerge = document.createElement('label');
    modeMerge.className = 'ed-import-mode';
    const mergeRadio = document.createElement('input');
    mergeRadio.type = 'radio';
    mergeRadio.name = 'ed-import-mode';
    mergeRadio.value = 'merge';
    const mergeCopy = document.createElement('span');
    mergeCopy.innerHTML =
      '<strong>Merge</strong> selected scenes into the current project';
    modeMerge.append(mergeRadio, mergeCopy);

    const mergeBlock = document.createElement('div');
    mergeBlock.className = 'ed-import-merge';

    const listHead = document.createElement('div');
    listHead.className = 'ed-import-list-head';
    const listLabel = document.createElement('span');
    listLabel.textContent = 'Scenes to add';
    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.className = 'ed-import-link';
    selectAllBtn.textContent = 'Select all';
    listHead.append(listLabel, selectAllBtn);

    const list = document.createElement('div');
    list.className = 'ed-import-list';
    const checks: HTMLInputElement[] = [];
    for (const scene of opts.scenes) {
      const row = document.createElement('label');
      row.className = 'ed-import-row';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.value = scene.id;
      checks.push(box);
      const name = document.createElement('span');
      name.className = 'ed-import-row-name';
      name.textContent = scene.name || 'Untitled';
      const dur = document.createElement('span');
      dur.className = 'ed-import-row-dur';
      dur.textContent = formatDuration(scene.duration);
      row.append(box, name, dur);
      list.append(row);
    }

    selectAllBtn.addEventListener('click', () => {
      const allOn = checks.every((c) => c.checked);
      for (const c of checks) c.checked = !allOn;
      selectAllBtn.textContent = allOn ? 'Select all' : 'Select none';
      refreshConfirm();
    });

    const masterOpt = document.createElement('label');
    masterOpt.className = 'ed-import-master';
    const masterCheck = document.createElement('input');
    masterCheck.type = 'checkbox';
    const masterCopy = document.createElement('span');
    masterCopy.textContent = 'Also add to master timeline';
    masterOpt.append(masterCheck, masterCopy);

    mergeBlock.append(listHead, list, masterOpt);

    const actions = document.createElement('div');
    actions.className = 'ed-import-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ed-btn';
    cancelBtn.textContent = 'Cancel';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'ed-btn primary';
    confirmBtn.textContent = 'Replace';
    actions.append(cancelBtn, confirmBtn);

    panel.append(title, summary, modeReplace, modeMerge, mergeBlock, actions);
    overlay.append(panel);
    document.body.append(overlay);

    let settled = false;
    const finish = (choice: ImportProjectChoice) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(choice);
    };

    const isMerge = () => mergeRadio.checked;

    const refreshConfirm = () => {
      const merge = isMerge();
      mergeBlock.classList.toggle('disabled', !merge);
      mergeBlock.setAttribute('aria-disabled', merge ? 'false' : 'true');
      for (const c of checks) c.disabled = !merge;
      masterCheck.disabled = !merge;
      selectAllBtn.disabled = !merge;
      if (merge) {
        const n = checks.filter((c) => c.checked).length;
        confirmBtn.textContent = n === 1 ? 'Merge 1 scene' : `Merge ${n} scenes`;
        confirmBtn.disabled = n === 0;
      } else {
        confirmBtn.textContent = 'Replace';
        confirmBtn.disabled = false;
      }
    };

    for (const c of checks) c.addEventListener('change', refreshConfirm);
    replaceRadio.addEventListener('change', refreshConfirm);
    mergeRadio.addEventListener('change', refreshConfirm);

    cancelBtn.addEventListener('click', () => finish({ mode: 'cancel' }));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish({ mode: 'cancel' });
    });
    confirmBtn.addEventListener('click', () => {
      if (isMerge()) {
        finish({
          mode: 'merge',
          sceneIds: checks.filter((c) => c.checked).map((c) => c.value),
          addToMaster: masterCheck.checked,
        });
      } else {
        finish({ mode: 'replace' });
      }
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish({ mode: 'cancel' });
      }
    };
    window.addEventListener('keydown', onKey);

    refreshConfirm();
    confirmBtn.focus();
  });
}
