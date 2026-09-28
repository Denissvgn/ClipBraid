/**
 * Platform adapter.
 *
 * Inside the Flow mini-app host, `Flow` is injected by the environment.
 * Anywhere else (plain browser, static hosting) a Web-standard shim takes
 * over: file pickers instead of the gallery, MediaRecorder instead of the
 * host microphone, and anchor-downloads instead of the host save dialogs.
 * The app code always talks to the same interface.
 */

export interface SelectedMedia {
  mediaId: string;
  base64: string;
  mimeType: string;
  type: 'image' | 'video' | 'audio' | string;
  name: string;
}

export interface RecordedAudio {
  base64: string;
  mimeType: string;
  durationMs: number;
}

export interface FlowApi {
  media: { select(opts: { filter: string }): Promise<SelectedMedia | null> };
  microphone: { record(opts: { durationMs: number }): Promise<RecordedAudio> };
  download(opts: { base64: string; mimeType: string; filename: string }): Promise<unknown>;
  save(opts: { base64: string; mimeType: string; name: string }): Promise<unknown>;
}

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const pickFile = (accept: string): Promise<File | null> =>
  new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // User cancelling the picker never fires change in most browsers;
    // resolving null on focus loss keeps the UI from hanging forever.
    window.addEventListener('focus', () => setTimeout(() => resolve(input.files?.[0] ?? null), 500), { once: true });
    input.click();
  });

const triggerDownload = (base64: string, mimeType: string, filename: string) => {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return Promise.resolve(true);
};

const browserShim: FlowApi = {
  media: {
    async select({ filter }) {
      const accept = filter === 'audio' ? 'audio/*' : filter === 'all' ? 'video/*,image/*' : `${filter}/*`;
      const file = await pickFile(accept);
      if (!file) return null;
      const mimeType = file.type || 'application/octet-stream';
      return {
        mediaId: `local_${crypto.randomUUID()}`,
        base64: await blobToBase64(file),
        mimeType,
        type: mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'image',
        name: file.name,
      };
    },
  },
  microphone: {
    async record({ durationMs }) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      try {
        const recorder = new MediaRecorder(stream);
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        const done = new Promise<Blob>((resolve) => {
          recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
        });
        recorder.start();
        await new Promise((r) => setTimeout(r, durationMs));
        if (recorder.state !== 'inactive') recorder.stop();
        stream.getTracks().forEach(t => t.stop());
        const blob = await done;
        return {
          base64: await blobToBase64(blob),
          mimeType: blob.type || 'audio/webm',
          durationMs,
        };
      } finally {
        stream.getTracks().forEach(t => t.stop());
      }
    },
  },
  download: ({ base64, mimeType, filename }) => triggerDownload(base64, mimeType, filename),
  save: ({ base64, mimeType, name }) => triggerDownload(base64, mimeType, name),
};

declare global {
  interface Window { Flow?: FlowApi }
}

export const Flow: FlowApi = window.Flow ?? browserShim;
export const isHostedFlow = (): boolean => window.Flow !== undefined;
