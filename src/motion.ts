import fs from 'node:fs';
import path from 'node:path';
import type { CDPSession, Page } from 'playwright';

/**
 * Motion replay (v0.9): a sidecar scenario recorded as it runs, so the replay shows the flow itself (a cursor
 * gliding to what it clicks, text being typed, the page reacting) instead of only the stills it ends in.
 *
 * Recording uses Chromium's screencast on the scenario's own page, in the warm context: the login, blocked hosts
 * and fixed clock stay as they are. Frames arrive only when the page paints, each with the time it was captured.
 * While a still is being taken (overlays hidden, scrollers grown, a full-page screenshot) the frames are dropped
 * and the time is cut out of the clip; a hold of the moment before takes its place, so the viewer sees the state
 * the still proves. Headless Chromium draws no mouse pointer, so the page gets a drawn one ({@link CURSOR_SCRIPT})
 * that follows the real mouse events; screenshots hide it ({@link CURSOR_HIDE_CSS}).
 */

/** Id of the drawn cursor element. */
export const CURSOR_ID = '__vp-cursor';

/** Passed as the screenshot `style`: stills never show the drawn cursor. */
export const CURSOR_HIDE_CSS = `#${CURSOR_ID} { display: none !important; }`;

/** sessionStorage key holding the last cursor position, so it reappears in place after a navigation. */
const CURSOR_POS_KEY = '__vp_cursor_pos';

/**
 * Init script for a recorded page: an arrow cursor that follows `mousemove`, and a ring where the mouse goes down.
 * It sits on `<html>` (not in the app root, so the page text and the rendered-component walk never see it) and
 * takes no pointer events. A string, like the scripts in `browser.ts`: transpilers must not touch it.
 */
export const CURSOR_SCRIPT = `(() => {
  if (window.top !== window) return;
  const ID = ${JSON.stringify(CURSOR_ID)};
  const KEY = ${JSON.stringify(CURSOR_POS_KEY)};
  let el = null;
  const ensure = () => {
    if (el && el.isConnected) return el;
    const root = document.documentElement;
    if (!root) return null;
    el = document.getElementById(ID);
    if (!el) {
      el = document.createElement('div');
      el.id = ID;
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;display:none;';
      el.innerHTML =
        '<svg width="22" height="26" viewBox="0 0 22 26" style="position:absolute;left:-2px;top:-1px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">' +
        '<path d="M2 1 L2 21 L7.2 16.4 L10.6 24.2 L14 22.7 L10.7 15 L17.6 15 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      root.appendChild(el);
    }
    return el;
  };
  const place = (x, y) => {
    const c = ensure();
    if (!c) return;
    c.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    c.style.display = 'block';
    try { sessionStorage.setItem(KEY, x + ',' + y); } catch (e) {}
  };
  const ring = (x, y) => {
    const root = document.documentElement;
    if (!root) return;
    const r = document.createElement('div');
    r.setAttribute('aria-hidden', 'true');
    r.style.cssText = 'position:fixed;left:' + (x - 18) + 'px;top:' + (y - 18) + 'px;width:36px;height:36px;border-radius:50%;' +
      'border:3px solid rgba(59,130,246,.9);background:rgba(59,130,246,.18);z-index:2147483646;pointer-events:none;' +
      'transform:scale(.3);opacity:1;transition:transform .45s ease-out,opacity .45s ease-out;';
    r.className = ID + '-ring';
    root.appendChild(r);
    requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = 'scale(1.25)'; r.style.opacity = '0'; }));
    setTimeout(() => r.remove(), 600);
  };
  window.__vpCursor = { place, ring };
  addEventListener('mousemove', (e) => place(e.clientX, e.clientY), { capture: true, passive: true });
  addEventListener('mousedown', (e) => ring(e.clientX, e.clientY), { capture: true, passive: true });
  const restore = () => {
    try {
      const saved = sessionStorage.getItem(KEY);
      if (saved) { const [x, y] = saved.split(',').map(Number); place(x, y); }
    } catch (e) {}
  };
  if (document.documentElement) restore();
  else document.addEventListener('DOMContentLoaded', restore, { once: true });
})()`;

/**
 * Init script for a recorded page: what stills hide stays hidden for the whole recording (dev overlays), and what
 * stills mask is covered the same way (a solid magenta box, contents invisible, layout untouched). Only selectors
 * that are valid CSS can be applied this way; it returns nothing, the caller logs the others.
 */
export function recordingStyleScript(hideSelectors: string[], maskSelectors: string[]): string {
  return `(() => {
  const hide = ${JSON.stringify(hideSelectors)};
  const mask = ${JSON.stringify(maskSelectors)};
  const valid = (s) => { try { document.createDocumentFragment().querySelector(s); return true; } catch (e) { return false; } };
  const rules = [];
  for (const s of hide.filter(valid)) rules.push(s + ', ' + s + ' * { visibility: hidden !important; }');
  for (const s of mask.filter(valid)) {
    rules.push(s + ' { background: rgb(255, 0, 255) !important; background-image: none !important; color: transparent !important; }');
    rules.push(s + ' * { visibility: hidden !important; }');
  }
  if (rules.length === 0) return;
  const add = () => {
    const root = document.head || document.documentElement;
    if (!root) return false;
    const style = document.createElement('style');
    style.setAttribute('data-vp-recording', '');
    style.textContent = rules.join('\\n');
    root.appendChild(style);
    return true;
  };
  if (!add()) document.addEventListener('DOMContentLoaded', add, { once: true });
})()`;
}

/** Mask selectors a recording cannot cover: Playwright-only syntax (`text=...`, `>>`) is not CSS. */
export function nonCssSelectors(selectors: string[]): string[] {
  return selectors.filter((s) => /^[a-z-]+=|>>|:has-text\(|:text\(|:visible\b/.test(s));
}

// ---- pacing --------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

/** Pause between two mouse moves of a glide (about one 60 Hz frame). */
export const GLIDE_STEP_MS = 16;

/** How long a glide over `distance` px takes: quick for short hops, never a crawl for long ones. */
export function glideMs(distance: number): number {
  return Math.round(Math.min(900, Math.max(280, 220 + distance * 0.55)));
}

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** The points of a glide from `from` to `to`, one per {@link GLIDE_STEP_MS}, eased, ending exactly on `to`. */
export function glidePath(from: Point, to: Point): Point[] {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance < 1) return [to];
  const steps = Math.max(2, Math.round(glideMs(distance) / GLIDE_STEP_MS));
  const points: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const k = easeInOut(i / steps);
    points.push({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k });
  }
  return points;
}

/** Delay between typed characters: the whole value takes about a second, within human-looking bounds. */
export function typingDelayMs(length: number): number {
  return Math.round(Math.min(70, Math.max(15, 1100 / Math.max(1, length))));
}

/** Extra pause after a click, fill or key press while recording, so the viewer sees the page react. */
export const ACTION_PAUSE_MS = 350;

// ---- the clip ----------------------------------------------------------------------

/** `manifest.json` of a recorded clip. Times are clip time in ms (the cut-out still captures already removed). */
export interface ClipManifest {
  version: 1;
  /** Scenario name. */
  name: string;
  width: number;
  height: number;
  /** Clip length (ms), the final hold included. */
  duration: number;
  /** JPEG files in this directory, by the clip time they appear at, ascending. */
  frames: Array<{ file: string; t: number }>;
  /** What the caption says from `t` on: the step being run. Ascending. */
  captions: Array<{ t: number; text: string }>;
}

export const CLIP_MANIFEST = 'manifest.json';

/** Read a clip's manifest; null when it is missing or not a clip with frames. */
export function readClip(dir: string): ClipManifest | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, CLIP_MANIFEST), 'utf8')) as ClipManifest;
    if (manifest.version !== 1 || !Array.isArray(manifest.frames) || manifest.frames.length === 0) return null;
    return manifest;
  } catch {
    return null;
  }
}

/** One output frame of a clip: which JPEG shows and which caption (index into `captions`, -1 for none). */
export interface ClipTick {
  file: string;
  caption: number;
}

/** The clip at a constant `fps`: each tick shows the newest frame captured at or before it. */
export function resampleClip(manifest: Pick<ClipManifest, 'frames' | 'captions' | 'duration'>, fps: number): ClipTick[] {
  const count = Math.max(1, Math.round((manifest.duration * fps) / 1000));
  const ticks: ClipTick[] = [];
  let f = 0;
  let c = -1;
  for (let k = 0; k < count; k++) {
    const t = (k * 1000) / fps;
    while (f + 1 < manifest.frames.length && manifest.frames[f + 1]!.t <= t) f++;
    while (c + 1 < manifest.captions.length && manifest.captions[c + 1]!.t <= t) c++;
    ticks.push({ file: manifest.frames[f]!.file, caption: c });
  }
  return ticks;
}

/** Paused stretch of wall time (a still being taken), shown as `holdMs` of the moment before. */
export interface Pause {
  from: number;
  to: number;
  holdMs: number;
}

/**
 * Wall time to clip time: each pause becomes its hold. A time inside a pause is null (a frame captured while the
 * page was prepared for the screenshot), or with `clamp` the end of that pause's hold (a caption starting there).
 */
export function clipTime(wall: number, start: number, pauses: Pause[], clamp = false): number | null {
  let t = wall - start;
  for (const pause of pauses) {
    if (wall < pause.from) break;
    if (wall < pause.to) return clamp ? pause.from - start - shift(pauses, pause) + pause.holdMs : null;
    t -= pause.to - pause.from - pause.holdMs;
  }
  return t;
}

/** How much earlier clip time runs than wall time at the start of `until`, from the pauses before it. */
function shift(pauses: Pause[], until: Pause): number {
  let total = 0;
  for (const pause of pauses) {
    if (pause === until) break;
    total += pause.to - pause.from - pause.holdMs;
  }
  return total;
}

/** Frames captured within this long after a still ends still show its preparation being undone. */
const RESUME_MARGIN_MS = 60;
/** Screencast frames closer together than this are thinned (a 30 fps cap keeps the clip small). */
const MIN_FRAME_GAP_MS = 33;

interface Captured {
  file: string;
  wall: number;
}

/**
 * Records one page with the CDP screencast into `dir` (JPEGs as they arrive, `manifest.json` on {@link stop}).
 * Never throws out of its methods: a recording that cannot start or breaks just ends up shorter or absent.
 */
export class ScreenRecorder {
  private cdp: CDPSession | null = null;
  private start = 0;
  private readonly pauses: Pause[] = [];
  private pausedAt: number | null = null;
  private readonly frames: Captured[] = [];
  private readonly captions: Array<{ wall: number; text: string }> = [];
  private lastWall = -Infinity;
  private seq = 0;
  private stopped = false;
  private failed: string | null = null;

  constructor(
    private readonly dir: string,
    private readonly name: string,
    private readonly viewport: { width: number; height: number },
    private readonly log: (message: string) => void = () => {},
  ) {}

  get started(): boolean {
    return this.cdp !== null;
  }

  async begin(page: Page): Promise<void> {
    if (this.cdp || this.stopped) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const cdp = await page.context().newCDPSession(page);
      cdp.on('Page.screencastFrame', (frame) => this.onFrame(cdp, frame));
      this.start = Date.now();
      this.cdp = cdp;
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 82,
        maxWidth: this.viewport.width,
        maxHeight: this.viewport.height,
        everyNthFrame: 1,
      });
    } catch (err) {
      this.failed = (err as Error).message.split('\n')[0] ?? 'screencast failed';
      this.log(`recording ${this.name}: ${this.failed}`);
      this.cdp = null;
    }
  }

  /** The step being run from now on (the caption). */
  caption(text: string): void {
    this.captions.push({ wall: Date.now(), text });
  }

  /** A still is being taken: drop what the screencast shows until {@link resume}. */
  pause(): void {
    if (this.pausedAt === null) this.pausedAt = Date.now();
  }

  /** The still is done; the paused stretch shows as `holdMs` of the frame before it. */
  resume(holdMs: number): void {
    if (this.pausedAt === null) return;
    this.pauses.push({ from: this.pausedAt, to: Date.now() + RESUME_MARGIN_MS, holdMs });
    this.pausedAt = null;
  }

  /**
   * Stop the screencast and write the manifest, ending on `tailMs` of the last frame. Null when nothing usable was
   * recorded (the directory is removed then).
   */
  async stop(tailMs: number): Promise<{ dir: string; frames: number; seconds: number } | null> {
    if (this.stopped) return null;
    this.stopped = true;
    const cdp = this.cdp;
    this.cdp = null;
    if (cdp) {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
    }
    if (this.pausedAt !== null) this.resume(0); // ended mid-still (a failure still): show nothing of it
    const end = Date.now();

    const frames: ClipManifest['frames'] = [];
    for (const frame of this.frames) {
      const t = clipTime(frame.wall, this.start, this.pauses);
      if (t === null) continue;
      frames.push({ file: frame.file, t: Math.max(0, Math.round(t)) });
    }
    if (frames.length === 0) {
      if (this.failed === null) this.log(`recording ${this.name}: no frames`);
      fs.rmSync(this.dir, { recursive: true, force: true });
      return null;
    }
    frames.sort((a, b) => a.t - b.t);
    frames[0]!.t = 0; // the clip opens on its first frame
    const captions: ClipManifest['captions'] = [];
    for (const c of this.captions) {
      const t = Math.max(0, Math.round(clipTime(c.wall, this.start, this.pauses, true)!), captions.at(-1)?.t ?? 0);
      captions.push({ t, text: c.text });
    }
    const lastFrame = frames.at(-1)!.t;
    const ended = Math.max(lastFrame, Math.round(clipTime(end, this.start, this.pauses, true)!));
    const manifest: ClipManifest = {
      version: 1,
      name: this.name,
      width: this.viewport.width,
      height: this.viewport.height,
      duration: ended + tailMs,
      frames,
      captions,
    };
    // Frames dropped from the manifest (captured mid-still) go too.
    const kept = new Set(frames.map((f) => f.file));
    for (const frame of this.frames) if (!kept.has(frame.file)) fs.rmSync(path.join(this.dir, frame.file), { force: true });
    fs.writeFileSync(path.join(this.dir, CLIP_MANIFEST), `${JSON.stringify(manifest)}\n`);
    return { dir: this.dir, frames: frames.length, seconds: Math.round(manifest.duration / 100) / 10 };
  }

  private onFrame(cdp: CDPSession, frame: { data: string; sessionId: number; metadata: { timestamp?: number; deviceWidth: number; deviceHeight: number } }): void {
    cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    if (this.stopped) return;
    const wall = frame.metadata.timestamp !== undefined ? frame.metadata.timestamp * 1000 : Date.now();
    if (this.pausedAt !== null && wall >= this.pausedAt) return;
    // A full-page screenshot resizes the view; any frame of another size is from one.
    if (Math.round(frame.metadata.deviceWidth) !== this.viewport.width || Math.round(frame.metadata.deviceHeight) !== this.viewport.height) return;
    if (wall - this.lastWall < MIN_FRAME_GAP_MS) {
      // Thin to the cap, but keep the newest picture: replace the previous frame's file in place.
      const previous = this.frames.at(-1);
      if (previous) this.write(previous.file, frame.data);
      return;
    }
    this.lastWall = wall;
    const file = `${String(++this.seq).padStart(6, '0')}.jpg`;
    if (this.write(file, frame.data)) this.frames.push({ file, wall });
  }

  private write(file: string, base64: string): boolean {
    try {
      fs.writeFileSync(path.join(this.dir, file), Buffer.from(base64, 'base64'));
      return true;
    } catch {
      return false;
    }
  }
}
