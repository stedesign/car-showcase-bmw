import { Viewer } from './viewer/Viewer';
import { Recorder } from './recorder/Recorder';
import { createEditor } from './authoring/Editor';
import { carSpecs } from './data/carSpecs';

const app = document.querySelector<HTMLDivElement>('#app')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const dropHint = document.querySelector<HTMLDivElement>('#drop-hint')!;

function setStatus(msg: string) {
  statusEl.textContent = msg;
}

console.info('[WRT specs]', carSpecs);

const viewer = new Viewer(app, setStatus);
(window as unknown as { __viewer: Viewer }).__viewer = viewer;

async function boot() {
  await viewer.init();
  viewer.startLoop();

  const recorder = new Recorder(viewer.canvas, {
    onState: (state, detail) => {
      if (detail) setStatus(detail);
      else if (state === 'recording') setStatus('Recording…');
      else if (state === 'encoding') setStatus('Encoding MP4…');
    },
  });

  const editor = await createEditor(viewer, recorder, setStatus);
  (window as unknown as { __editor: typeof editor }).__editor = editor;
  setupDragDrop(viewer);
  setStatus('Director ready — frame cameras, keyframe, Record');
}

function setupDragDrop(viewer: Viewer) {
  const onDrag = (event: DragEvent) => {
    event.preventDefault();
    dropHint.classList.add('visible');
  };
  const onDragLeave = (event: DragEvent) => {
    event.preventDefault();
    dropHint.classList.remove('visible');
  };
  const onDrop = async (event: DragEvent) => {
    event.preventDefault();
    dropHint.classList.remove('visible');
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.glb') && !lower.endsWith('.gltf')) {
      setStatus('Please drop a .glb or .gltf file');
      return;
    }
    setStatus(`Loading ${file.name}…`);
    try {
      await viewer.loadModel(file);
    } catch (err) {
      console.error(err);
      setStatus(`Failed to load ${file.name}`);
    }
  };

  window.addEventListener('dragenter', onDrag);
  window.addEventListener('dragover', onDrag);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
}

boot().catch((err) => {
  console.error(err);
  const msg = err instanceof Error ? err.message : String(err);
  setStatus(`Failed to start viewer: ${msg}`);
});
