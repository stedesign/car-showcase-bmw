import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export type RecorderState = 'idle' | 'recording' | 'encoding' | 'error';

export type RecorderOptions = {
  fps?: number;
  videoBitsPerSecond?: number;
  mimeType?: string;
  onState?: (state: RecorderState, detail?: string) => void;
};

function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return 'video/webm';
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export class Recorder {
  private canvas: HTMLCanvasElement;
  private options: Required<Pick<RecorderOptions, 'fps' | 'videoBitsPerSecond'>> &
    RecorderOptions;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private stream: MediaStream | null = null;
  private ffmpeg: FFmpeg | null = null;
  private ffmpegReady = false;
  state: RecorderState = 'idle';

  constructor(canvas: HTMLCanvasElement, options: RecorderOptions = {}) {
    this.canvas = canvas;
    this.options = {
      fps: options.fps ?? 30,
      videoBitsPerSecond: options.videoBitsPerSecond ?? 12_000_000,
      mimeType: options.mimeType,
      onState: options.onState,
    };
  }

  private setState(state: RecorderState, detail?: string) {
    this.state = state;
    this.options.onState?.(state, detail);
  }

  get isRecording() {
    return this.state === 'recording';
  }

  configure(partial: Partial<Pick<RecorderOptions, 'fps' | 'videoBitsPerSecond'>>) {
    if (partial.fps != null) this.options.fps = partial.fps;
    if (partial.videoBitsPerSecond != null) {
      this.options.videoBitsPerSecond = partial.videoBitsPerSecond;
    }
  }

  async ensureFfmpeg(): Promise<FFmpeg> {
    if (this.ffmpeg && this.ffmpegReady) return this.ffmpeg;
    this.ffmpeg = new FFmpeg();
    const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
    await this.ffmpeg.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    this.ffmpegReady = true;
    return this.ffmpeg;
  }

  start() {
    if (this.state === 'recording') return;

    const mimeType = this.options.mimeType ?? pickMimeType();
    this.stream = this.canvas.captureStream(this.options.fps);
    this.chunks = [];

    try {
      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType,
        videoBitsPerSecond: this.options.videoBitsPerSecond,
      });
    } catch {
      this.mediaRecorder = new MediaRecorder(this.stream);
    }

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };

    this.mediaRecorder.onerror = () => {
      this.setState('error', 'MediaRecorder failed');
    };

    this.mediaRecorder.start(200);
    this.setState('recording');
  }

  async stopAndExport(basename = 'wrt-paddock-viewer'): Promise<void> {
    if (!this.mediaRecorder || this.state !== 'recording') return;

    const webmBlob = await new Promise<Blob>((resolve, reject) => {
      this.mediaRecorder!.onstop = () => {
        resolve(new Blob(this.chunks, { type: 'video/webm' }));
      };
      this.mediaRecorder!.onerror = () => reject(new Error('Recording failed'));
      this.mediaRecorder!.stop();
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
    });

    this.setState('encoding', 'Converting to MP4…');

    try {
      const mp4 = await this.webmToMp4(webmBlob);
      downloadBlob(mp4, `${basename}.mp4`);
      this.setState('idle', 'Exported MP4');
    } catch (err) {
      console.warn('MP4 encode failed, downloading WebM fallback', err);
      downloadBlob(webmBlob, `${basename}.webm`);
      this.setState('idle', 'Exported WebM (MP4 encode unavailable)');
    }
  }

  private async webmToMp4(webm: Blob): Promise<Blob> {
    const ffmpeg = await this.ensureFfmpeg();
    const inputName = 'input.webm';
    const outputName = 'output.mp4';

    await ffmpeg.writeFile(inputName, await fetchFile(webm));
    await ffmpeg.exec([
      '-i',
      inputName,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      outputName,
    ]);
    const data = await ffmpeg.readFile(outputName);
    await ffmpeg.deleteFile(inputName);
    await ffmpeg.deleteFile(outputName);

    const bytes =
      typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    return new Blob([bytes], { type: 'video/mp4' });
  }
}
