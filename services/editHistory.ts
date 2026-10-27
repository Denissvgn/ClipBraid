import type { ProjectSnapshot } from "./project";
import { validateProjectMetadata } from "./project";
import type { MediaSourceStore, SourceLease } from "./mediaSources";

export type ProjectContent = Omit<ProjectSnapshot, "currentTime">;
interface Entry { project: ProjectContent; label: string; group: number | null }
export interface HistoryState {
  project: ProjectContent; canUndo: boolean; canRedo: boolean;
  undoLabel: string; redoLabel: string; dirty: boolean; exported: boolean;
  retainedBytes: number; limited: boolean;
}
const ids = (project: ProjectContent) => new Set([...project.mediaAssets, ...project.audioTracks].map(item => item.sourceId));
export const contentKey = (project: ProjectContent) => JSON.stringify(project);
export const emptyProject = (): ProjectContent => ({ mediaAssets: [], audioTracks: [], aspectRatio: "16:9", fitMode: "contain", transitionDuration: .5 });
function immutable(project: ProjectContent): ProjectContent {
  const { currentTime: _, ...validated } = validateProjectMetadata({ ...project, currentTime: 0 });
  return Object.freeze({ ...validated,
    mediaAssets: Object.freeze(validated.mediaAssets.map(item => Object.freeze({ ...item }))) as unknown as ProjectContent["mediaAssets"],
    audioTracks: Object.freeze(validated.audioTracks.map(item => Object.freeze({ ...item }))) as unknown as ProjectContent["audioTracks"],
  });
}

/** Session-local metadata commands; original bytes are shared through leases.
 * History is bounded by commands and unique originals retained outside the live
 * document. Background saves, exports, playback and proxy work never add edits.
 */
export class EditHistory {
  private project = immutable(emptyProject());
  private past: Entry[] = [];
  private future: Entry[] = [];
  private leases = new Map<string, SourceLease>();
  private listeners = new Set<() => void>();
  private saved = contentKey(this.project);
  private exported: string | null = null;
  private group: number | null = null;
  private groupSequence = 0;
  private limited = false;
  generation = 0;
  private state!: HistoryState;
  constructor(private store: MediaSourceStore, private maximum = 50, private byteLimit = 256 * 1048576) {
    if(!Number.isSafeInteger(maximum)||maximum<1||!Number.isSafeInteger(byteLimit)||byteLimit<0)throw new Error("Invalid edit history limit.");
    this.publish();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.state;
  beginGroup = (restart=true) => { if(restart||this.group===null)this.group = ++this.groupSequence; };
  endGroup = () => { this.group = null; };
  update(label: string, change: (project: ProjectContent) => ProjectContent) {
    const next = immutable(change(this.project));
    if (contentKey(next) === contentKey(this.project)) return false;
    const grouped = this.group !== null && this.past.at(-1)?.group === this.group;
    const past = grouped ? [...this.past] : [...this.past, { project: this.project, label, group: this.group }];
    this.install(next, past, []);return true;
  }
  undo = () => {
    this.endGroup();const entry = this.past.at(-1);if (!entry) return false;
    this.install(entry.project, this.past.slice(0,-1), [...this.future, { project: this.project, label: entry.label, group: null }]);return true;
  };
  redo = () => {
    this.endGroup();const entry = this.future.at(-1);if (!entry) return false;
    this.install(entry.project, [...this.past, { project: this.project, label: entry.label, group: null }], this.future.slice(0,-1));return true;
  };
  reset(project: ProjectContent, saved: boolean) {
    this.endGroup();const next=immutable(project);
    this.install(next, [], []);
    this.generation++;
    this.saved=saved?contentKey(next):"";this.exported=null;this.limited=false;this.publish();
  }
  markSaved(project: ProjectContent, generation=this.generation) { if(generation!==this.generation)return;this.saved=contentKey(project);this.publish(); }
  markExported(project: ProjectContent, generation=this.generation) { if(generation!==this.generation)return;this.exported=contentKey(project);this.publish(); }
  dispose() { for(const lease of this.leases.values())lease.release();this.leases.clear();this.past=[];this.future=[];this.endGroup();this.listeners.clear();this.publish(); }
  private retained(project: ProjectContent, past: Entry[], future: Entry[]) {
    const live=ids(project),retained=new Set([...past,...future].flatMap(entry=>[...ids(entry.project)]));
    return [...retained].filter(id=>!live.has(id)).reduce((sum,id)=>sum+(this.store.get(id)?.byteLength??0),0);
  }
  private install(project: ProjectContent, past: Entry[], future: Entry[]) {
    let limited=this.limited;
    while(past.length+future.length>this.maximum||this.retained(project,past,future)>this.byteLimit) {
      if(past.length)past.shift();else if(future.length)future.shift();else break;limited=true;
    }
    const required=new Set([project,...past.map(entry=>entry.project),...future.map(entry=>entry.project)].flatMap(value=>[...ids(value)]));
    const additions: SourceLease[]=[];
    try { for(const id of required)if(!this.leases.has(id))additions.push(this.store.acquire(id,"edit-history")); }
    catch(error){for(const lease of additions)lease.release();throw error}
    try { this.store.restorePins(ids(project)); }
    catch(error){for(const lease of additions)lease.release();throw error}
    for(const lease of additions)this.leases.set(lease.sourceId,lease);
    this.project=project;this.past=past;this.future=future;this.limited=limited;
    for(const [id,lease] of this.leases)if(!required.has(id)){this.leases.delete(id);lease.release()}
    this.publish();
  }
  private publish() {
    const key=contentKey(this.project);
    this.state={project:this.project,canUndo:!!this.past.length,canRedo:!!this.future.length,
      undoLabel:this.past.at(-1)?.label??"",redoLabel:this.future.at(-1)?.label??"",dirty:key!==this.saved,exported:key===this.exported,
      retainedBytes:this.retained(this.project,this.past,this.future),limited:this.limited};
    for(const listener of this.listeners)listener();
  }
}
