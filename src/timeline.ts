import fs from 'node:fs';
import path from 'node:path';
import type { FrameStatus } from './triage.js';

/** Which glob set caused the capture: a screen file changed, a backend file did, a sidecar scenario file did, or `visual-proof params set` asked for it (`params`). */
export type Trigger = 'screen' | 'backend' | 'sidecar' | 'params';

/** Which tier filled a route's params (v0.8); see the brief, "Dynamic route params". */
export type ParamsFrom = 'session' | 'config' | 'file' | 'source' | 'discovered';

/** One executed step of a sidecar scenario, as kept on its frames. */
export interface FrameStep {
  /** 1-based line in the sidecar file. */
  line: number;
  /** The step as written (trimmed source line). */
  text: string;
}

export interface Frame {
  id: string;
  sessionId: string;
  /** Concrete path that was loaded, e.g. `/invoices/1`. */
  route: string;
  /** Route pattern, e.g. `/invoices/:id`. */
  routeKey: string;
  at: string;
  treeHash: string;
  trigger: Trigger;
  sourceFile?: string;
  status: FrameStatus;
  reasons: string[];
  /**
   * Repo-relative component files that were mounted in the page (Vue 3, from `__file`), or null when that
   * could not be read (production build, non-Vue app, render check off). Absent on frames from older versions.
   */
  renderedFiles?: string[] | null;
  /** Where the capture spent its time (ms), to tune `settle`; absent on frames from older versions. */
  timing?: { settleMs: number; screenshotMs: number; discoveryMs?: number };
  /**
   * Sidecar frames only: every step executed from the start of the scenario up to and including the `still`
   * (for an error frame, up to and including the step that failed). Absent on route frames.
   */
  steps?: FrameStep[];
  /** v0.8: the tier that filled the route's params; absent for a route without params and on older frames. */
  paramsFrom?: ParamsFrom;
  /** v0.8: with `paramsFrom: "discovered"`, the page whose links gave the id. */
  paramsFoundOn?: string;
  /**
   * v0.9, sidecar frames only: the motion clip of the run the still came from (a directory relative to the scratch
   * dir, `clips/<id>`). Every still of one run shares it.
   */
  clip?: string;
  /** Path of the PNG relative to the scratch dir. */
  png: string;
}

export type NewFrame = Omit<Frame, 'id' | 'png'>;

const INDEX_FILE = 'index.jsonl';
const CLIPS_DIR = 'clips';
let clipSeq = 0;

/**
 * Scratch-dir frame store: `index.jsonl` (one Frame per line, oldest first) plus
 * `frames/<id>.png`, and `clips/<id>/` for motion clips (v0.9). All I/O is synchronous so ids cannot interleave within a process;
 * the next id is re-derived from the index on every append so restarts continue the sequence.
 */
export class Timeline {
  private readonly indexPath: string;
  private readonly framesDir: string;

  constructor(
    readonly scratchDir: string,
    private readonly maxFrames: number,
  ) {
    if (!Number.isInteger(maxFrames) || maxFrames < 1) {
      throw new RangeError(`maxFrames must be a positive integer, got ${maxFrames}`);
    }
    this.indexPath = path.join(scratchDir, INDEX_FILE);
    this.framesDir = path.join(scratchDir, 'frames');
    fs.mkdirSync(this.framesDir, { recursive: true });
  }

  append(frame: NewFrame, png: Buffer): Frame {
    const records = this.readIndex();
    const id = formatId(Math.max(0, ...records.map((r) => parseId(r.id))) + 1);
    const record: Frame = { ...frame, id, png: `frames/${id}.png` };

    // PNG first: the index must never reference a file that is not there.
    const pngPath = this.pngPath(record);
    const tempPath = `${pngPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, png);
    fs.renameSync(tempPath, pngPath);
    fs.appendFileSync(this.indexPath, `${JSON.stringify(record)}\n`);

    this.evict([...records, record]);
    return record;
  }

  list(filter: { sessionId?: string } = {}): Frame[] {
    const records = this.readIndex();
    return filter.sessionId === undefined ? records : records.filter((r) => r.sessionId === filter.sessionId);
  }

  /** Latest frame for a route (matched by concrete path or route pattern) captured at `treeHash`. */
  latestAtTree(route: string, treeHash: string): Frame | undefined {
    return this.readIndex()
      .reverse()
      .find((r) => r.treeHash === treeHash && (r.route === route || r.routeKey === route));
  }

  /** Latest frame for a route (matched by concrete path or route pattern) at any tree. */
  latest(route: string): Frame | undefined {
    return this.readIndex()
      .reverse()
      .find((r) => r.route === route || r.routeKey === route);
  }

  pngPath(frame: Pick<Frame, 'png'>): string {
    return path.join(this.scratchDir, frame.png);
  }

  /** A fresh, not yet created clip directory: `clip` goes on the frames, `dir` to the recorder. */
  newClip(): { clip: string; dir: string } {
    const clip = `${CLIPS_DIR}/c-${Date.now().toString(36)}-${process.pid}-${(++clipSeq).toString(36)}`;
    return { clip, dir: path.join(this.scratchDir, clip) };
  }

  clipPath(frame: Pick<Frame, 'clip'>): string | undefined {
    return frame.clip ? path.join(this.scratchDir, frame.clip) : undefined;
  }

  /** Remove a clip no frame was written for (a discarded batch). */
  dropClip(clip: string): void {
    fs.rmSync(path.join(this.scratchDir, clip), { recursive: true, force: true });
  }

  private evict(records: Frame[]): void {
    const excess = records.length - this.maxFrames;
    if (excess <= 0) return;

    const tempPath = `${this.indexPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, records.slice(excess).map((r) => `${JSON.stringify(r)}\n`).join(''));
    fs.renameSync(tempPath, this.indexPath);
    for (const old of records.slice(0, excess)) fs.rmSync(this.pngPath(old), { force: true });
    // A clip goes with the last frame that uses it.
    const kept = new Set(records.slice(excess).map((r) => r.clip));
    for (const old of records.slice(0, excess)) if (old.clip && !kept.has(old.clip)) this.dropClip(old.clip);
  }

  private readIndex(): Frame[] {
    let text: string;
    try {
      text = fs.readFileSync(this.indexPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const records: Frame[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line) as Frame);
      } catch {
        // A torn trailing line from a crashed writer; skip it.
      }
    }
    return records;
  }
}

function formatId(n: number): string {
  return `f-${String(n).padStart(6, '0')}`;
}

function parseId(id: string): number {
  const n = Number(id.slice(2));
  return Number.isFinite(n) ? n : 0;
}
