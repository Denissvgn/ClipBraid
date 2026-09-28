import { toBlobURL } from '@ffmpeg/util';
/**
 * FFmpeg WASM service using a classic worker.
 * Bypasses CORS issues in the Flow sandbox.
 */
const MSG = {
  LOAD: 'LOAD', EXEC: 'EXEC', WRITE_FILE: 'WRITE_FILE',
  READ_FILE: 'READ_FILE', DELETE_FILE: 'DELETE_FILE',
  ERROR: 'ERROR', LOG: 'LOG', PROGRESS: 'PROGRESS',
} as const;
// Primary and fallback CDN URLs
const CDNS = [
  'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
  'https://cdn.jsdelivr.net/gh/ffmpegwasm/core@0.12.6/dist/umd' // Github fallback
];
class FFmpegService {
  private worker: Worker | null = null;
  private loaded = false;
  private msgId = 0;
  private callbacks = new Map<number, {
    resolve: (v: any) => void;
    reject: (e: any) => void;
  }>();
  private logCb: ((msg: string) => void) | null = null;
  private progressCb: ((p: { progress: number }) => void) | null = null;
  async load(onLog?: (msg: string) => void) {
    if (this.loaded && this.worker) return;
    this.logCb = onLog || null;
    let error: any = null;
    for (const baseURL of CDNS) {
      try {
        this.logCb?.(`Connecting to ${new URL(baseURL).hostname}...`);

        const coreURL = await toBlobURL(
          `${baseURL}/ffmpeg-core.js`, 'text/javascript'
        );
        const wasmURL = await toBlobURL(
          `${baseURL}/ffmpeg-core.wasm`, 'application/wasm'
        );
        this.logCb?.(`Assets fetched. Spawning worker...`);
        const workerBlob = this.buildWorkerBlob();
        this.worker = new Worker(workerBlob);
        this.worker.onmessage = ({ data: { id, type, data } }) => {
          if (type === MSG.LOG) {
            this.logCb?.(data?.message || '');
            return;
          }
          if (type === MSG.PROGRESS) {
            this.progressCb?.(data);
            return;
          }
          if (type === MSG.ERROR) {
            const cb = this.callbacks.get(id);
            if (cb) { this.callbacks.delete(id); cb.reject(new Error(data)); }
            return;
          }
          const cb = this.callbacks.get(id);
          if (cb) { this.callbacks.delete(id); cb.resolve(data); }
        };
        await this.send(MSG.LOAD, { coreURL, wasmURL });
        this.loaded = true;
        this.logCb?.(`FFmpeg Initialized.`);
        return;
      } catch (e) {
        console.warn(`Failed to load from ${baseURL}:`, e);
        error = e;
        if (this.worker) {
          this.worker.terminate();
          this.worker = null;
        }
        continue;
      }
    }
    throw new Error(`FFmpeg failed to load: ${error?.message || 'Check connection'}`);
  }
  private send(type: string, data?: any, transfer?: Transferable[]): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.worker) return reject(new Error('FFmpeg not initialized'));
      const id = this.msgId++;
      this.callbacks.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, data }, transfer || []);
    });
  }
  private buildWorkerBlob(): string {
    const script = `
var MSG = {
  LOAD: "LOAD", EXEC: "EXEC",
  WRITE_FILE: "WRITE_FILE", READ_FILE: "READ_FILE",
  DELETE_FILE: "DELETE_FILE", ERROR: "ERROR",
  LOG: "LOG", PROGRESS: "PROGRESS",
};
var ffmpeg = null;
var load = function(opts) {
  importScripts(opts.coreURL);
  if (!self.createFFmpegCore) {
    throw new Error("failed to import ffmpeg-core.js");
  }
  return self.createFFmpegCore({
    mainScriptUrlOrBlob: opts.coreURL
      + "#" + btoa(JSON.stringify({ wasmURL: opts.wasmURL })),
  }).then(function(core) {
    ffmpeg = core;
    ffmpeg.setLogger(function(data) {
      self.postMessage({ type: MSG.LOG, data: data });
    });
    ffmpeg.setProgress(function(data) {
      self.postMessage({ type: MSG.PROGRESS, data: data });
    });
    return true;
  });
};
self.onmessage = function(e) {
  var id = e.data.id;
  var type = e.data.type;
  var _data = e.data.data;
  var trans = [];
  var data;
  var handleResult = function(result) {
    data = result;
    if (data instanceof Uint8Array) trans.push(data.buffer);
    self.postMessage({ id: id, type: type, data: data }, trans);
  };
  var handleError = function(err) {
    self.postMessage({ id: id, type: MSG.ERROR, data: err.toString() });
  };
  try {
    if (type !== MSG.LOAD && !ffmpeg) {
       handleError(new Error("ffmpeg is not loaded"));
       return;
    }
    switch (type) {
      case MSG.LOAD:
        load(_data).then(handleResult).catch(handleError);
        return;
      case MSG.EXEC:
        ffmpeg.setTimeout(_data.timeout || -1);
        ffmpeg.exec.apply(ffmpeg, _data.args);
        data = ffmpeg.ret;
        ffmpeg.reset();
        break;
      case MSG.WRITE_FILE:
        ffmpeg.FS.writeFile(_data.path, _data.data);
        data = true;
        break;
      case MSG.READ_FILE:
        data = ffmpeg.FS.readFile(_data.path);
        break;
      case MSG.DELETE_FILE:
        ffmpeg.FS.unlink(_data.path);
        data = true;
        break;
      default:
        handleError(new Error("unknown message type: " + type));
        return;
    }
  } catch (err) {
    handleError(err);
    return;
  }
  if (data instanceof Uint8Array) trans.push(data.buffer);
  self.postMessage({ id: id, type: type, data: data }, trans);
};
`;
    return URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
  }
  async exec(args: string[]) {
    const ret = await this.send(MSG.EXEC, { args, timeout: -1 });
    if (ret !== 0) throw new Error(`FFmpeg exit code ${ret}`);
    return ret;
  }
  async writeFile(name: string, data: Uint8Array | ArrayBuffer) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (!bytes || bytes.byteLength === 0) throw new Error(`writeFile: empty payload for ${name}`);
    return this.send(MSG.WRITE_FILE, { path: name, data: bytes }, [bytes.buffer]);
  }
  async readFile(name: string) {
    return this.send(MSG.READ_FILE, { path: name });
  }
  async deleteFile(name: string) {
    return this.send(MSG.DELETE_FILE, { path: name });
  }
  async getDuration(name: string): Promise<number> {
    let duration = 0;
    const oldLog = this.logCb;
    this.logCb = (msg) => {
      oldLog?.(msg);
      const match = msg.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d+)/);
      if (match) {
        const h = parseInt(match[1], 10);
        const m = parseInt(match[2], 10);
        const s = parseFloat(match[3]);
        duration = h * 3600 + m * 60 + s;
      }
    };
    try {
      await this.exec(['-i', name]);
    } catch (e) { /* Metadata check always throws as there is no output */ }
    this.logCb = oldLog;
    return duration;
  }
  onProgress(cb: (p: { progress: number }) => void) {
    this.progressCb = cb;
  }
}
export const ffmpegService = new FFmpegService();
