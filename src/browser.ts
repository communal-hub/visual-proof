import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser as PwBrowser, type BrowserContext, type Locator, type Page, type Request } from 'playwright';
import type { Config } from './config.js';
import { SIDECAR_TEXT_LIMIT } from './decisions/sidecar.js';
import { firstLine } from './text.js';
import { hostBlocker } from './hosts.js';
import { ACTION_PAUSE_MS, CURSOR_HIDE_CSS, CURSOR_SCRIPT, GLIDE_STEP_MS, glidePath, nonCssSelectors, recordingStyleScript, ScreenRecorder, typingDelayMs, type Point } from './motion.js';
import { normalizeRenderedFiles, renderedFilesScript } from './rendered.js';
import { FAILED_STILL, roleEmail, type SidecarStep } from './sidecar.js';
import type { FrameStep } from './timeline.js';
import type { TriageSignals } from './triage.js';

/** Max characters of app-root text kept on a capture. */
export const TEXT_EXCERPT_LIMIT = 2048;

export interface CaptureSignals extends TriageSignals {
  /** `innerText` of the app root, trimmed and cut to {@link TEXT_EXCERPT_LIMIT} characters. */
  text: string;
}

/** What was done to the page before the screenshot. */
export interface CaptureLayout {
  /** Short description (`main.content`) of the inner scroll container that was expanded, or null. */
  scrollContainer: string | null;
  /** Document height in CSS pixels after any expansion, before the cap. */
  fullHeight: number;
  /** Height of the still in CSS pixels (never above `maxCaptureHeight`). */
  height: number;
  /** The document was taller than `maxCaptureHeight` and the still was cut off there. */
  capped: boolean;
  /** Elements matched by the hide selectors (all set to `visibility: hidden`). */
  hidden: number;
  /** Elements covered by a `maskSelectors` box in the still. */
  masked: number;
}

/** Where a capture spent its time (ms), for tuning `settle`. */
export interface CaptureTiming {
  /** From `load` until the page counted as settled: network idle, fonts, two frames, reading the DOM (and any re-settle after a self-navigation). */
  settleMs: number;
  /** From the settled page to the PNG: rendered-component walk, preparing the page, the screenshot call. */
  screenshotMs: number;
}

export interface CaptureResult {
  png: Buffer;
  signals: CaptureSignals;
  /** URL the page ended on after redirects and client-side routing. */
  finalUrl: string;
  /** Up to 8 KB of the app root's visible text (A4 decisions: stored in a sidecar next to the PNG); absent from fakes. */
  pageText?: string;
  /** Absent from capturers that do not prepare the page (test fakes). */
  layout?: CaptureLayout;
  /** Component files mounted in the page (see {@link Frame.renderedFiles}); absent from fakes. */
  renderedFiles?: string[] | null;
  /** Absent from fakes. */
  timing?: CaptureTiming;
}

/** Outcome of {@link Capturer.prime}. */
export interface PrimeResult {
  /** Passes made (2 when the first one saw Vite reload the page or re-optimize dependencies). */
  passes: number;
  /** Times the page navigated on its own or a module answered "Outdated Optimize Dep", over all passes. */
  reloads: number;
  navOk: boolean;
  httpStatus: number | null;
}

/** What fetching an app-relative JSON path produced. `error` is set for a transport failure, a non-2xx status or a non-JSON body. */
export interface JsonResponse {
  /** HTTP status, or 0 when no response arrived. */
  status: number;
  json?: unknown;
  error?: string;
}

/** What loading a page and reading its `a[href]` produced (`Capturer.collectLinks`, link discovery). */
export interface LinkPage {
  ok: boolean;
  /** Absolute `href`s of every `a[href]`, in DOM order. */
  hrefs: string[];
  /** Where the page ended up after redirects (a login redirect shows here). */
  finalUrl?: string;
  error?: string;
  /** Time to load and settle the page. */
  ms: number;
}

/** What `watch` needs from a browser; lets tests inject a fake. */
export interface Capturer {
  /** Best-effort early login so the first capture is not slower than the rest. */
  warm(): Promise<void>;
  capture(url: string): Promise<CaptureResult>;
  /**
   * Load `url` the way a capture would (so Vite compiles its modules and optimizes dependencies) without taking
   * a screenshot, repeating once when Vite reloaded the page. Optional: capturers without it are not warmed up.
   */
  prime?(url: string): Promise<PrimeResult>;
  /**
   * GET an app-relative path with the logged-in context (same cookies as captures) and decode the JSON body.
   * Optional: capturers without it cannot resolve `paramSources`.
   */
  getJson?(urlPath: string): Promise<JsonResponse>;
  /**
   * Run a sidecar scenario in the warm context and return a still per `still` step (or an error still where a step
   * failed). Optional: capturers without it skip sidecars.
   */
  runScenario?(plan: ScenarioPlan): Promise<ScenarioResult>;
  /**
   * Load `url` in a fresh page of the logged-in context, wait for it to settle like a capture does, and return its
   * `a[href]` in DOM order (no screenshot). Optional: capturers without it cannot discover route params.
   */
  collectLinks?(url: string): Promise<LinkPage>;
  close(): Promise<void>;
}

/** A parsed sidecar with its `goto` targets already resolved to concrete URLs (the watcher owns route params). */
export interface ScenarioPlan {
  /** Config-relative path of the sidecar file. */
  file: string;
  name: string;
  steps: SidecarStep[];
  /** Per `goto` line: where it goes, or why it cannot (unfilled route params). */
  gotos: Map<number, { url: string; path: string } | { error: string }>;
  /**
   * Record the run as a motion clip (v0.9) into `dir`, which must not exist yet: a drawn cursor glides to what it
   * clicks and fills are typed, and each still shows for `holdMs`. Absent: run as fast as possible, no clip.
   */
  record?: { dir: string; holdMs: number };
}

/** One still of a scenario: a normal capture plus the steps that led to it. */
export interface ScenarioStill {
  /** The `still` name, or {@link FAILED_STILL} for the synthetic frame of a failure after the last still. */
  name: string;
  at: string;
  png: Buffer;
  signals: CaptureSignals;
  renderedFiles: string[] | null;
  timing?: CaptureTiming;
  /** The page's full text (for the decisions claim check), like {@link CaptureResult.pageText}. */
  pageText?: string;
  /** Steps run from the start of the scenario up to and including this still (or the failing step). */
  steps: FrameStep[];
  /** True for the error still of a failed step. */
  failed: boolean;
}

export interface ScenarioResult {
  stills: ScenarioStill[];
  /** The motion clip, when the plan asked for one and something was recorded. */
  clip?: RecordedClip;
  /** The step that stopped the scenario, if any. */
  failure?: { line: number; text: string; reason: string };
  ms: number;
}

export interface RecordedClip {
  /** The plan's `record.dir`, holding the JPEGs and `manifest.json`. */
  dir: string;
  frames: number;
  seconds: number;
}

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

export type BrowserConfig = Pick<
  Config,
  | 'repoDir'
  | 'appUrl'
  | 'viteUrl'
  | 'ignoreHTTPSErrors'
  | 'viewport'
  | 'login'
  | 'appRoot'
  | 'spinnerSelectors'
  | 'scrollContainer'
  | 'maxCaptureHeight'
  | 'hideSelectors'
  | 'renderCheck'
  | 'fixedTime'
  | 'maskSelectors'
  | 'blockHosts'
  | 'allowHosts'
  | 'settle'
  | 'roles'
>;

export interface BrowserOptions {
  log?: (message: string) => void;
  /** Navigation timeout. Default 30 s. */
  navigationTimeoutMs?: number;
  /** After a login failure, skip new login attempts for this long and reuse the failure. Default 30 s. */
  loginBackoffMs?: number;
  /** Clock for the login back-off; tests inject a fake. */
  now?: () => number;
  /** Runs on the prepared page right before the screenshot (tests inspect what the still will show). */
  beforeScreenshot?: (page: Page) => Promise<void>;
  /** Total time one sidecar scenario may take before it is stopped. Default 60 s. */
  scenarioTimeoutMs?: number;
  /** How long a sidecar step waits for its selector. Default 5 s. */
  stepTimeoutMs?: number;
}

export const SCENARIO_TIMEOUT_MS = 60_000;
export const STEP_TIMEOUT_MS = 5000;

const STALE_DEP_RETRIES = 2;
const STALE_DEP_PAUSE_MS = 300;

function hasStaleDepError(consoleErrors: string[]): boolean {
  return consoleErrors.some((message) => message.includes('Outdated Optimize Dep'));
}

const LOGIN_BACKOFF_MS = 30_000;

const LOGIN_PATH = /(^|\/)(login|log-in|signin|sign-in)(\/|$)/i;

/**
 * One warm headless Chromium with a single BrowserContext (so one login serves every capture).
 * Each capture opens a fresh page, so a still can never show a pre-update render held by an
 * older page, and always closes it.
 */
export class Browser implements Capturer {
  private browser: PwBrowser | null = null;
  private context: BrowserContext | null = null;
  private loggedIn = false;
  /** Email the shared context is logged in as (the default `login.email`, or a role's during a sidecar scenario). */
  private sessionEmail: string | null = null;
  /** The last login failure and when it happened; reused (not retried) until the back-off passes. */
  private loginFailure: { error: LoginError; at: number } | null = null;
  private readonly pages = new Set<Page>();
  /** True for request URLs the configured `blockHosts` / `allowHosts` abort. */
  private readonly isBlocked: (url: string) => boolean;
  private blockedCount = 0;
  /** Mask selectors already reported as invalid, so the log says it once. */
  private readonly badMasks = new Set<string>();
  /** The motion-clip warning about Playwright-only mask selectors was logged. */
  private warnedUncoveredMasks = false;

  constructor(
    private readonly config: BrowserConfig,
    private readonly options: BrowserOptions = {},
  ) {
    this.isBlocked = hostBlocker({
      blockHosts: config.blockHosts,
      allowHosts: config.allowHosts,
      ownUrls: [config.appUrl, config.viteUrl],
    });
  }

  static async launch(config: BrowserConfig, options: BrowserOptions = {}): Promise<Browser> {
    const browser = new Browser(config, options);
    await browser.ensureContext();
    return browser;
  }

  async warm(): Promise<void> {
    try {
      await this.ensureLoggedIn();
    } catch (err) {
      this.log(`warm-up login failed: ${(err as Error).message}`);
    }
  }

  async capture(url: string): Promise<CaptureResult> {
    const context = await this.ensureContext();
    let authFailure: string | undefined;
    try {
      await this.ensureLoggedIn();
    } catch (err) {
      authFailure = (err as Error).message;
    }

    let attempt = await this.captureOnce(context, url);
    if (this.config.login.type === 'http-hook' && !authFailure) {
      const reason = authProblem(url, attempt);
      if (reason) {
        // Session expired or was never accepted: log in again and retry once.
        this.log(`capture ${url}: ${reason}; logging in again`);
        this.loggedIn = false;
        try {
          await this.ensureLoggedIn();
          attempt = await this.captureOnce(context, url);
          authFailure = authProblem(url, attempt) ?? undefined;
        } catch (err) {
          authFailure = (err as Error).message;
        }
      }
    }

    // A cold Vite dev server answers module requests with 504 "Outdated Optimize Dep" while it
    // re-bundles dependencies discovered on first load. That is transient, not a broken page.
    for (let retry = 0; retry < STALE_DEP_RETRIES && hasStaleDepError(attempt.signals.consoleErrors); retry++) {
      this.log(`capture ${url}: Vite is re-optimizing dependencies (504 Outdated Optimize Dep); capturing again`);
      await new Promise((resolve) => setTimeout(resolve, STALE_DEP_PAUSE_MS));
      attempt = await this.captureOnce(context, url);
    }

    const { png, signals, finalUrl, layout, renderedFiles, timing, pageText } = attempt;
    if (authFailure) signals.authFailure = authFailure;
    return { png, signals, finalUrl, ...(layout ? { layout } : {}), renderedFiles, timing, pageText };
  }

  async getJson(urlPath: string): Promise<JsonResponse> {
    const context = await this.ensureContext();
    try {
      await this.ensureLoggedIn();
    } catch (err) {
      // Carry on: an open endpoint still works, and a closed one answers 401/403 below with the real reason.
      this.log(`getJson ${urlPath}: ${(err as Error).message}`);
    }
    const target = new URL(urlPath, this.config.appUrl.endsWith('/') ? this.config.appUrl : `${this.config.appUrl}/`).href;
    const get = () => context.request.get(target, { failOnStatusCode: false, timeout: 15_000, headers: { accept: 'application/json' } });
    try {
      let response = await get();
      if ((response.status() === 401 || response.status() === 403) && this.config.login.type === 'http-hook') {
        this.log(`getJson ${urlPath}: HTTP ${response.status()}; logging in again`);
        this.loggedIn = false;
        try {
          await this.ensureLoggedIn();
          response = await get();
        } catch (err) {
          return { status: response.status(), error: `HTTP ${response.status()} (${(err as Error).message})` };
        }
      }
      const status = response.status();
      if (status < 200 || status >= 300) return { status, error: `HTTP ${status}` };
      try {
        return { status, json: await response.json() };
      } catch {
        return { status, error: 'response is not JSON' };
      }
    } catch (err) {
      return { status: 0, error: (err as Error).message.split('\n')[0] ?? 'request failed' };
    }
  }

  async collectLinks(url: string): Promise<LinkPage> {
    const started = Date.now();
    const context = await this.ensureContext();
    try {
      await this.ensureLoggedIn();
    } catch (err) {
      this.log(`collectLinks ${url}: ${(err as Error).message}`);
    }
    const load = async (): Promise<{ loaded: Loaded; finalUrl: string }> => {
      const loaded = await this.loadPage(context, url);
      return { loaded, finalUrl: loaded.page.url() };
    };
    let { loaded, finalUrl } = await load();
    const authReason = this.config.login.type === 'http-hook' ? authProblem(url, { httpStatus: loaded.httpStatus, finalUrl }) : null;
    if (authReason) {
      // Session expired or was never accepted: log in again and look once more.
      this.log(`collectLinks ${url}: ${authReason}; logging in again`);
      this.pages.delete(loaded.page);
      await loaded.page.close().catch(() => {});
      this.loggedIn = false;
      try {
        await this.ensureLoggedIn();
      } catch (err) {
        this.log(`collectLinks ${url}: ${(err as Error).message}`);
      }
      ({ loaded, finalUrl } = await load());
    }
    try {
      if (!loaded.navOk) return { ok: false, hrefs: [], finalUrl, error: 'navigation failed', ms: Date.now() - started };
      if (loaded.httpStatus !== null && loaded.httpStatus >= 400) {
        return { ok: false, hrefs: [], finalUrl, error: `HTTP ${loaded.httpStatus}`, ms: Date.now() - started };
      }
      const hrefs = (await loaded.page.evaluate(LINKS_SCRIPT).catch(() => null)) as string[] | null;
      if (hrefs === null) return { ok: false, hrefs: [], finalUrl, error: 'reading the links failed (the page navigated away)', ms: Date.now() - started };
      return { ok: true, hrefs, finalUrl: loaded.page.url(), ms: Date.now() - started };
    } finally {
      this.pages.delete(loaded.page);
      await loaded.page.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.loggedIn = false;
    this.sessionEmail = null;
    this.loginFailure = null;
    for (const page of [...this.pages]) await page.close().catch(() => {});
    this.pages.clear();
    await browser?.close().catch(() => {});
  }

  // ---- lifecycle -----------------------------------------------------------

  private async ensureContext(): Promise<BrowserContext> {
    if (this.browser && !this.browser.isConnected()) {
      this.log('browser disconnected; relaunching');
      await this.close();
    }
    if (this.context) return this.context;
    this.browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    this.context = await this.browser.newContext({
      viewport: this.config.viewport,
      ignoreHTTPSErrors: this.config.ignoreHTTPSErrors,
      reducedMotion: 'reduce',
    });
    this.loggedIn = false;
    this.sessionEmail = null;
    this.loginFailure = null;
    try {
      await this.installRoutes(this.context);
      await this.installClock(this.context);
    } catch (err) {
      await this.close();
      throw err;
    }
    return this.context;
  }

  /** Abort requests to blocked hosts before any page navigates. */
  private async installRoutes(context: BrowserContext): Promise<void> {
    if (this.config.blockHosts.length === 0) return;
    await context.route(
      (url) => this.isBlocked(url.href),
      (route) => {
        this.blockedCount++;
        return route.abort().catch(() => {});
      },
    );
  }

  /** Freeze `Date` at `fixedTime` for every page of the context (timers keep running). */
  private async installClock(context: BrowserContext): Promise<void> {
    const { fixedTime } = this.config;
    if (!fixedTime) return;
    const clock = (context as unknown as { clock?: { setFixedTime?: (time: Date) => Promise<void> } }).clock;
    if (typeof clock?.setFixedTime !== 'function') {
      this.log('fixedTime ignored: this Playwright version has no clock API (needs >= 1.45)');
      return;
    }
    await clock.setFixedTime(new Date(fixedTime));
    this.log(`clock fixed at ${fixedTime}`);
  }

  // ---- login ---------------------------------------------------------------

  private async ensureLoggedIn(): Promise<void> {
    if (this.config.login.type !== 'http-hook') return;
    // A scenario that logged in as another role leaves the context on that role until it restores the default.
    if (this.loggedIn && this.sessionEmail === this.config.login.email) return;
    const failure = this.loginFailure;
    if (failure) {
      const backoffMs = this.options.loginBackoffMs ?? LOGIN_BACKOFF_MS;
      if (this.now() - failure.at < backoffMs) throw failure.error;
      this.loginFailure = null;
    }
    try {
      await this.login();
    } catch (err) {
      if (err instanceof LoginError) this.loginFailure = { error: err, at: this.now() };
      throw err;
    }
    this.loginFailure = null;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** POST the login hook through the context so its session cookie lands in the shared jar. */
  private async login(email: string | undefined = this.config.login.email): Promise<void> {
    const { login, appUrl, repoDir } = this.config;
    if (login.type !== 'http-hook' || !login.url) return;
    const context = await this.ensureContext();

    const headers: Record<string, string> = {};
    if (login.tokenFile) {
      const tokenPath = path.resolve(repoDir, login.tokenFile);
      let token: string;
      try {
        token = fs.readFileSync(tokenPath, 'utf8').trim();
      } catch (err) {
        throw new LoginError(`login failed: cannot read token file ${login.tokenFile} (${(err as NodeJS.ErrnoException).code ?? err})`);
      }
      headers[login.tokenHeader] = token;
    }

    const target = new URL(login.url, appUrl.endsWith('/') ? appUrl : `${appUrl}/`).href;
    let status: number;
    try {
      const response = await context.request.post(target, {
        data: { email },
        headers,
        failOnStatusCode: false,
        timeout: 15_000,
        maxRedirects: 0,
      });
      status = response.status();
    } catch (err) {
      throw new LoginError(`login failed: ${(err as Error).message.split('\n')[0]}`);
    }
    if (status < 200 || status >= 300) throw new LoginError(`login failed: HTTP ${status} from ${login.url}`);
    this.loggedIn = true;
    this.sessionEmail = email ?? null;
    this.log(`logged in as ${email}`);
  }

  // ---- capture -------------------------------------------------------------

  /** A fresh page in the warm context with the listeners every capture and scenario needs. */
  private async openPage(context: BrowserContext): Promise<Watched> {
    const page = await context.newPage();
    this.pages.add(page);
    const watched: Watched = { page, network: new NetworkIdle(page), consoleErrors: [], pageErrors: [], navigations: 0 };
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      // Chromium reports a request we aborted ourselves as a failed resource load; that is not the app's error.
      if (/net::ERR_(FAILED|BLOCKED_BY_CLIENT)/.test(msg.text()) && this.isBlocked(msg.location().url)) return;
      watched.consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => watched.pageErrors.push(err.message || String(err)));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) watched.navigations++;
    });
    return watched;
  }

  /**
   * Wait until the loaded page is stable and read it. The page can navigate again on its own after `load` (Vite
   * reloads when it re-optimizes dependencies; apps redirect after a guard), so re-settle whenever that happens
   * mid-stabilisation.
   */
  private async settleAndRead(watched: Watched, label: string, maxWaitMs = this.config.settle.maxWaitMs): Promise<Dom> {
    const { page, network } = watched;
    let dom = emptyDom();
    for (let attempt = 0; attempt < 4; attempt++) {
      const seen = watched.navigations;
      // No request in flight for `settle.networkIdleMs`, but give up after `settle.maxWaitMs`.
      await network.wait(this.config.settle.networkIdleMs, maxWaitMs);
      const settled = await settle(page);
      const read = settled
        ? await readDom(page, this.config.appRoot, this.config.spinnerSelectors, (m) => this.log(`capture ${label}: reading the page failed: ${m}`))
        : null;
      if (read && watched.navigations === seen) return read;
      if (read) dom = read;
      this.log(`capture ${label}: page navigated while settling (attempt ${attempt + 1})`);
    }
    return dom;
  }

  /**
   * Open a fresh page, navigate and wait for the app to settle. The page is returned open: the caller
   * screenshots it if it wants to and must close it.
   */
  private async loadPage(context: BrowserContext, url: string): Promise<Loaded> {
    const watched = await this.openPage(context);
    const { page, network, consoleErrors, pageErrors } = watched;

    try {
      let navOk = true;
      let httpStatus: number | null = null;
      try {
        const response = await page.goto(url, {
          waitUntil: 'load',
          timeout: this.options.navigationTimeoutMs ?? 30_000,
        });
        httpStatus = response?.status() ?? null;
      } catch (err) {
        navOk = false;
        this.log(`capture ${url}: navigation failed: ${(err as Error).message.split('\n')[0]}`);
      }

      const settleStart = Date.now();
      const dom = navOk ? await this.settleAndRead(watched, url) : emptyDom();
      return {
        page,
        navOk,
        httpStatus,
        dom,
        consoleErrors,
        pageErrors,
        // The initial navigation is the first one; anything after it is the page moving on its own.
        extraNavigations: Math.max(0, watched.navigations - 1),
        network,
        settleMs: Date.now() - settleStart,
      };
    } catch (err) {
      this.pages.delete(page);
      await page.close().catch(() => {});
      throw err;
    }
  }

  private async captureOnce(context: BrowserContext, url: string): Promise<CaptureResult & { httpStatus: number | null }> {
    const loaded = await this.loadPage(context, url);
    const { page, navOk, httpStatus, dom, consoleErrors, pageErrors } = loaded;
    const { fullText: _fullText, ...signalDom } = dom; // the long text goes to the sidecar, not into the signals
    try {
      const shot = await this.shoot(page, url, loaded.network, navOk);
      return {
        png: shot.png,
        finalUrl: page.url(),
        pageText: dom.fullText,
        httpStatus,
        ...(shot.layout ? { layout: shot.layout } : {}),
        renderedFiles: shot.renderedFiles,
        timing: { settleMs: loaded.settleMs, screenshotMs: shot.ms },
        signals: { navOk, httpStatus, consoleErrors, pageErrors, ...signalDom, ...(shot.error ? { screenshotError: shot.error } : {}) },
      };
    } finally {
      this.pages.delete(page);
      await page.close().catch(() => {});
    }
  }

  /**
   * The screenshot half of a capture, on a settled page: the rendered-component walk, preparing the page (hide
   * overlays, grow inner scrollers), masks, the PNG. Shared by route captures and scenario stills.
   */
  private async shoot(
    page: Page,
    url: string,
    network: NetworkIdle,
    navOk: boolean,
  ): Promise<{ png: Buffer; layout?: CaptureLayout; renderedFiles: string[] | null; error?: string; ms: number }> {
    const started = Date.now();
    let layout: CaptureLayout | undefined;
    let renderedFiles: string[] | null = null;
    if (navOk && this.config.renderCheck !== 'off') {
      renderedFiles = await page
        .evaluate(renderedFilesScript(this.config.appRoot))
        .then((raw) => normalizeRenderedFiles(raw as string[] | null, this.config.repoDir), () => null);
    }
    if (navOk) {
      try {
        layout = await this.preparePage(page, url, network);
      } catch (err) {
        this.log(`capture ${url}: preparing the page for the screenshot failed: ${(err as Error).message.split('\n')[0]}`);
      }
      await this.options.beforeScreenshot?.(page);
    }

    let error: string | undefined;
    const { width } = this.config.viewport;
    const masks = await this.maskLocators(page, url);
    if (layout) layout.masked = masks.count;
    const png = await page
      .screenshot({
        fullPage: true,
        ...(masks.locators.length > 0 ? { mask: masks.locators } : {}),
        // Keep the viewport width and cut the height at the cap, whatever overflows horizontally or below.
        ...(layout ? { clip: { x: 0, y: 0, width, height: layout.height } } : {}),
        type: 'png',
        animations: 'disabled',
        caret: 'hide',
        style: CURSOR_HIDE_CSS,
      })
      .catch((err: Error) => {
        error = err.message.split('\n')[0] || err.name;
        this.log(`capture ${url}: screenshot failed: ${error}`);
        return Buffer.from(BLANK_PNG_BASE64, 'base64');
      });
    return { png, ...(layout ? { layout } : {}), renderedFiles, ...(error ? { error } : {}), ms: Date.now() - started };
  }

  async prime(url: string): Promise<PrimeResult> {
    const context = await this.ensureContext();
    try {
      await this.ensureLoggedIn();
    } catch (err) {
      this.log(`prime ${url}: ${(err as Error).message}`);
    }
    let reloads = 0;
    let last: Loaded | null = null;
    let passes = 0;
    // Vite reloads the page (and answers 504) while it re-optimizes dependencies found on first load;
    // one more pass shows the settled app and leaves everything compiled.
    for (let pass = 0; pass < 2; pass++) {
      passes++;
      const loaded = await this.loadPage(context, url);
      this.pages.delete(loaded.page);
      await loaded.page.close().catch(() => {});
      last = loaded;
      const stale = hasStaleDepError(loaded.consoleErrors) ? 1 : 0;
      reloads += loaded.extraNavigations + stale;
      if (loaded.extraNavigations + stale === 0) break;
      this.log(`prime ${url}: Vite reloaded the page during pass ${pass + 1}; settling again`);
    }
    return { passes, reloads, navOk: last?.navOk ?? false, httpStatus: last?.httpStatus ?? null };
  }

  // ---- sidecar scenarios ----------------------------------------------------

  /**
   * Run a sidecar scenario on one fresh page of the warm context: the steps in order, a still (settle, triage
   * signals, rendered components, prepared screenshot) at each `still`. The first step that fails stops the
   * scenario and becomes an error still for the next pending `still` (or a synthetic one when none is left), with
   * a screenshot of where the page was. The whole run is bounded (`scenarioTimeoutMs`, 60 s): a scenario cannot
   * hang. `login <role>` switches the shared session; the default login is restored afterwards.
   */
  async runScenario(plan: ScenarioPlan): Promise<ScenarioResult> {
    const context = await this.ensureContext();
    const started = Date.now();
    const deadline = started + (this.options.scenarioTimeoutMs ?? SCENARIO_TIMEOUT_MS);
    const stepTimeout = this.options.stepTimeoutMs ?? STEP_TIMEOUT_MS;

    let authFailure: string | undefined;
    try {
      await this.ensureLoggedIn();
    } catch (err) {
      authFailure = (err as Error).message;
    }

    const watched = await this.openPage(context);
    const { page } = watched;
    let recorder: ScreenRecorder | undefined;
    if (plan.record) {
      recorder = new ScreenRecorder(plan.record.dir, plan.name, this.config.viewport, (m) => this.log(m));
      try {
        // The recording should show the app's own transitions; stills disable animations themselves.
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.addInitScript(CURSOR_SCRIPT);
        await page.addInitScript(recordingStyleScript(this.config.hideSelectors, this.config.maskSelectors));
        const uncovered = nonCssSelectors(this.config.maskSelectors);
        if (uncovered.length > 0 && !this.warnedUncoveredMasks) {
          this.warnedUncoveredMasks = true;
          this.log(`recording: maskSelectors ${uncovered.map((m) => JSON.stringify(m)).join(', ')} are not CSS and stay visible in motion clips`);
        }
      } catch (err) {
        this.log(`scenario ${plan.file}: preparing the recording failed: ${firstLine(err)}`);
      }
    }
    const run: ScenarioRun = {
      plan,
      watched,
      stills: [],
      executed: [],
      httpStatus: null,
      authFailure,
      deadline,
      stepTimeout,
      cancelled: false,
      failure: undefined,
      current: null,
      recorder,
      holdMs: plan.record?.holdMs ?? 0,
      mouse: { x: Math.round(this.config.viewport.width / 2), y: Math.round(this.config.viewport.height / 2) },
    };

    let clip: RecordedClip | undefined;
    try {
      const body = this.runSteps(run).catch((err: Error) => {
        // A bug or a closed page, not a step failing: still report it against the step it happened in.
        if (!run.failure) run.failure = failureOf(run.current, err.message.split('\n')[0] || err.name);
      });
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        body.then(() => 'done' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()) + 1000);
        }),
      ]);
      clearTimeout(timer);
      if (outcome === 'timeout') {
        run.cancelled = true;
        run.failure ??= failureOf(run.current, `scenario exceeded ${Math.round((this.options.scenarioTimeoutMs ?? SCENARIO_TIMEOUT_MS) / 1000)} s`);
        this.log(`scenario ${plan.file}: stopped after exceeding its time limit`);
      }

      if (run.failure) run.stills.push(await this.failureStill(run));
    } finally {
      if (recorder) clip = (await recorder.stop(run.holdMs).catch(() => null)) ?? undefined;
      this.pages.delete(page);
      await page.close().catch(() => {});
      await this.restoreDefaultLogin();
    }
    return { stills: run.stills, ...(clip ? { clip } : {}), ...(run.failure ? { failure: run.failure } : {}), ms: Date.now() - started };
  }

  private async runSteps(run: ScenarioRun): Promise<void> {
    for (const step of run.plan.steps) {
      if (run.cancelled) return;
      run.current = step;
      run.executed.push({ line: step.line, text: step.text });
      if (run.deadline - Date.now() <= 0) {
        run.failure = failureOf(step, 'scenario exceeded its time limit');
        return;
      }
      if (run.recorder) {
        // Start once there is a page to show: before the first step that is not a navigation or a login.
        if (!run.recorder.started && step.verb !== 'goto' && step.verb !== 'login') await this.beginRecording(run);
        run.recorder.caption(`${run.plan.name} / ${step.text}`);
      }
      const reason = await this.runStep(run, step);
      if (run.cancelled) return;
      if (run.recorder && reason === null && step.verb === 'goto') {
        if (!run.recorder.started) await this.beginRecording(run);
        else await run.watched.page.mouse.move(run.mouse.x, run.mouse.y).catch(() => {}); // the new page's cursor
      }
      if (reason !== null) {
        run.failure = failureOf(step, reason);
        return;
      }
    }
  }

  /** One step; null on success, else why it failed. */
  private async runStep(run: ScenarioRun, step: SidecarStep): Promise<string | null> {
    const { page, network } = run.watched;
    const left = (): number => Math.max(1, run.deadline - Date.now());
    const timeout = (): number => Math.min(run.stepTimeout, left());
    const label = `${run.plan.file}:${step.line}`;

    switch (step.verb) {
      case 'goto':
        return this.stepGoto(run, step, label);

      case 'click':
      case 'fill': {
        const target = await this.findTarget(page, step.selector, timeout());
        if (typeof target === 'string') return target;
        try {
          if (run.recorder?.started) await this.humanAction(run, step, target, timeout);
          else if (step.verb === 'click') await target.click({ timeout: timeout() });
          else await target.fill(step.value, { timeout: timeout() });
        } catch (err) {
          return `${step.verb} failed: ${firstLine(err)}`;
        }
        await this.afterAction(run);
        return null;
      }

      case 'press': {
        try {
          if (run.recorder?.started) await page.keyboard.press(step.key, { delay: 60 });
          else await page.keyboard.press(step.key);
        } catch (err) {
          return `press failed: ${firstLine(err)}`;
        }
        await this.afterAction(run);
        return null;
      }

      case 'wait': {
        if (step.ms !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(step.ms!, left())));
          return null;
        }
        const target = await this.findTarget(page, step.selector!, timeout());
        return typeof target === 'string' ? target : null;
      }

      case 'login': {
        const email = roleEmail(step.role, this.config);
        if (this.config.login.type !== 'http-hook') return 'login needs login.type "http-hook"';
        if (email === null) return `unknown role ${JSON.stringify(step.role)}`;
        try {
          // A fresh session: nothing of the previous role's cookies may leak into this one.
          await (await this.ensureContext()).clearCookies();
          this.loggedIn = false;
          await this.login(email);
        } catch (err) {
          this.loggedIn = false;
          return `login as ${step.role} failed: ${firstLine(err)}`;
        }
        return null;
      }

      case 'still': {
        const started = Date.now();
        const dom = await this.settleAndRead(run.watched, label, Math.min(this.config.settle.maxWaitMs, left()));
        const settleMs = Date.now() - started;
        run.recorder?.pause(); // preparing the page for the screenshot is not part of the flow
        const shot = await this.shoot(page, label, network, true);
        await page.evaluate(UNPREPARE_SCRIPT).catch(() => {}); // the scenario goes on from this very page
        run.recorder?.resume(run.holdMs);
        if (run.cancelled) return null; // the time limit already ended this scenario; its failure still is the last one
        const signals = this.scenarioSignals(run, dom, shot.error);
        run.stills.push({
          name: step.name,
          at: new Date().toISOString(),
          png: shot.png,
          signals,
          renderedFiles: shot.renderedFiles,
          timing: { settleMs, screenshotMs: shot.ms },
          pageText: dom.fullText,
          steps: [...run.executed],
          failed: false,
        });
        return null;
      }
    }
  }

  private async stepGoto(run: ScenarioRun, step: Extract<SidecarStep, { verb: 'goto' }>, label: string): Promise<string | null> {
    const resolved = run.plan.gotos.get(step.line);
    if (!resolved) return `cannot resolve ${step.target}`;
    if ('error' in resolved) return `${resolved.error} (add routeParams)`;
    const { page } = run.watched;
    const { url } = resolved;
    const navTimeout = (): number => Math.min(this.options.navigationTimeoutMs ?? 30_000, Math.max(1, run.deadline - Date.now()));

    const visit = async (): Promise<string | null> => {
      run.watched.consoleErrors.length = 0;
      run.watched.pageErrors.length = 0;
      let response;
      try {
        response = await page.goto(url, { waitUntil: 'load', timeout: navTimeout() });
      } catch (err) {
        return `navigation failed: ${firstLine(err)}`;
      }
      run.httpStatus = response?.status() ?? null;
      await this.settleAndRead(run.watched, label, Math.min(this.config.settle.maxWaitMs, Math.max(1, run.deadline - Date.now())));
      return null;
    };

    let failure = await visit();
    if (failure) return failure;

    // A cold dev server answers module requests with 504 "Outdated Optimize Dep" while it re-bundles; transient.
    for (let retry = 0; retry < STALE_DEP_RETRIES && hasStaleDepError(run.watched.consoleErrors); retry++) {
      this.log(`scenario ${label}: Vite is re-optimizing dependencies (504 Outdated Optimize Dep); loading again`);
      await new Promise((resolve) => setTimeout(resolve, STALE_DEP_PAUSE_MS));
      failure = await visit();
      if (failure) return failure;
    }

    if (this.config.login.type === 'http-hook') {
      let reason = authProblem(url, { httpStatus: run.httpStatus, finalUrl: page.url() });
      if (reason) {
        this.log(`scenario ${label}: ${reason}; logging in again`);
        try {
          // Same identity as before the redirect: the role the scenario is in, not necessarily the default.
          this.loggedIn = false;
          await this.login(this.sessionEmail ?? this.config.login.email);
          failure = await visit();
          if (failure) return failure;
          reason = authProblem(url, { httpStatus: run.httpStatus, finalUrl: page.url() });
        } catch (err) {
          reason = firstLine(err);
        }
        run.authFailure = reason ?? undefined;
      }
    }
    return null;
  }

  /** A locator for the first match once it is visible, or why not: `selector not found` / `not visible` / invalid. */
  private async findTarget(page: Page, selector: string, timeoutMs: number): Promise<Locator | string> {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      return locator;
    } catch (err) {
      if ((err as Error).name !== 'TimeoutError') return `invalid selector: ${firstLine(err)}`;
      const present = await page.locator(selector).count().catch(() => 0);
      return present > 0 ? 'selector not visible' : 'selector not found';
    }
  }

  /** After an action: let the requests it started finish, then paint. A short version of the capture settle. */
  private async afterAction(run: ScenarioRun): Promise<void> {
    const cap = Math.min(this.config.settle.maxWaitMs, 2000, Math.max(1, run.deadline - Date.now()));
    await run.watched.network.wait(this.config.settle.networkIdleMs, cap);
    await settle(run.watched.page);
    // Recording: give the viewer a beat to see what the action did.
    if (run.recorder?.started) await sleep(Math.min(ACTION_PAUSE_MS, Math.max(0, run.deadline - Date.now())));
  }

  /** Start the screencast with the cursor in the middle of the view. */
  private async beginRecording(run: ScenarioRun): Promise<void> {
    const { page } = run.watched;
    await page.mouse.move(run.mouse.x, run.mouse.y).catch(() => {});
    await run.recorder!.begin(page);
  }

  /**
   * A click or fill the way a person does it, for the recording: the cursor glides to the element, then clicks it,
   * or focuses it and types the value. Typing that does not end in the value (masked or date inputs) falls back to
   * a plain fill, so the page ends where a fill would leave it.
   */
  private async humanAction(
    run: ScenarioRun,
    step: Extract<SidecarStep, { verb: 'click' | 'fill' }>,
    target: Locator,
    timeout: () => number,
  ): Promise<void> {
    const { page } = run.watched;
    await target.scrollIntoViewIfNeeded({ timeout: timeout() }).catch(() => {});
    const box = await target.boundingBox().catch(() => null);
    if (box) {
      const to = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
      for (const point of glidePath(run.mouse, to)) {
        if (run.cancelled || run.deadline - Date.now() <= 0) break;
        await page.mouse.move(point.x, point.y);
        await sleep(GLIDE_STEP_MS);
      }
      run.mouse = to;
      await sleep(Math.min(120, Math.max(0, run.deadline - Date.now())));
    }
    if (step.verb === 'click') {
      await target.click({ timeout: timeout() });
      return;
    }
    // Show the press without clicking: a click could open what a fill never would (a date picker).
    await page.evaluate(`window.__vpCursor && window.__vpCursor.ring(${run.mouse.x}, ${run.mouse.y})`).catch(() => {});
    await target.fill('', { timeout: timeout() });
    await target.focus({ timeout: timeout() });
    await target.pressSequentially(step.value, { delay: typingDelayMs(step.value.length), timeout: timeout() });
    const typed = await target.inputValue({ timeout: 500 }).catch(() => null);
    if (typed !== null && typed !== step.value) await target.fill(step.value, { timeout: timeout() });
  }

  private scenarioSignals(run: ScenarioRun, fullDom: Dom, screenshotError?: string): CaptureSignals {
    const { fullText: _fullText, ...dom } = fullDom; // the long text goes to the page-text sidecar, not into the signals
    const { consoleErrors, pageErrors } = run.watched;
    const signals: CaptureSignals = {
      navOk: true,
      httpStatus: run.httpStatus,
      // Errors since the previous still belong to this one; the next still starts clean.
      consoleErrors: consoleErrors.splice(0),
      pageErrors: pageErrors.splice(0),
      ...dom,
      ...(screenshotError ? { screenshotError } : {}),
    };
    if (run.authFailure) signals.authFailure = run.authFailure;
    return signals;
  }

  /**
   * The error still for a failed scenario: it takes the name of the next `still` that was not reached (the line of
   * the failing step or later), else the synthetic {@link FAILED_STILL}. It shows the page as the step left it.
   */
  private async failureStill(run: ScenarioRun): Promise<ScenarioStill> {
    const failure = run.failure!;
    const pending = run.plan.steps.find((s) => s.verb === 'still' && s.line >= failure.line);
    const name = pending && pending.verb === 'still' ? pending.name : FAILED_STILL;
    const { page, network } = run.watched;
    run.recorder?.pause();

    // Best effort and bounded: the page may be hung, closed, or mid-navigation.
    const guard = <T>(work: Promise<T>, fallback: T, ms = 4000): Promise<T> =>
      Promise.race([work.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
    const dom = await guard(readDom(page, this.config.appRoot, this.config.spinnerSelectors).then((d) => d ?? emptyDom()), emptyDom());
    const shot = await guard(
      this.shoot(page, `${run.plan.file}:${failure.line}`, network, true),
      { png: Buffer.from(BLANK_PNG_BASE64, 'base64'), renderedFiles: null, error: 'page unavailable', ms: 0 } as Awaited<ReturnType<Browser['shoot']>>,
      8000,
    );
    const signals = this.scenarioSignals(run, dom);
    signals.stepFailure = `line ${failure.line} ${failure.text}: ${failure.reason}`;
    return {
      name,
      at: new Date().toISOString(),
      png: shot.png,
      signals,
      renderedFiles: shot.renderedFiles,
      timing: { settleMs: 0, screenshotMs: shot.ms },
      pageText: dom.fullText,
      steps: [...run.executed],
      failed: true,
    };
  }

  /** Put the context back on the default login after a scenario that switched roles. Never throws. */
  private async restoreDefaultLogin(): Promise<void> {
    if (this.config.login.type !== 'http-hook' || this.sessionEmail === this.config.login.email) return;
    try {
      await this.context?.clearCookies();
      this.loggedIn = false;
      await this.ensureLoggedIn();
    } catch (err) {
      this.loggedIn = false; // the next capture logs in again
      this.log(`restoring the default login failed: ${firstLine(err)}`);
    }
  }

  /**
   * Make the page look the way the still should: hide dev overlays, let an inner scroll container grow the
   * document so a full-page screenshot sees all of its content, and work out how tall the still will be.
   * The page is closed after the capture, so nothing is undone.
   */
  private async preparePage(page: Page, url: string, network: NetworkIdle): Promise<CaptureLayout> {
    const { hideSelectors, scrollContainer, maxCaptureHeight } = this.config;
    const prepared = (await page.evaluate(prepareScript(hideSelectors, scrollContainer ?? null))) as Prepared;
    if (scrollContainer && prepared.containerMissing) {
      this.log(`capture ${url}: scrollContainer ${JSON.stringify(scrollContainer)} matched nothing; using the page as it is`);
    }
    let fullHeight = prepared.fullHeight;
    if (prepared.grew || prepared.lazyImages > 0) {
      // More of the page is on screen now: lazy images start loading, virtual lists render more rows.
      await network.wait(this.config.settle.networkIdleMs, Math.min(this.config.settle.maxWaitMs, 1500));
      await settle(page);
      fullHeight = await page.evaluate(MEASURE_SCRIPT).then(Number, () => fullHeight);
    }
    const height = Math.min(Math.max(fullHeight, this.config.viewport.height), maxCaptureHeight);
    const capped = fullHeight > maxCaptureHeight;
    if (prepared.grew) {
      this.log(`capture ${url}: expanded scroll container ${prepared.container} to ${fullHeight}px`);
    }
    if (capped) this.log(`capture ${url}: page is ${fullHeight}px tall; cut off at maxCaptureHeight ${maxCaptureHeight}px`);
    return { scrollContainer: prepared.grew ? prepared.container : null, fullHeight, height, capped, hidden: prepared.hidden, masked: 0 };
  }

  /**
   * Locators for `maskSelectors` that match at least one element. A selector Playwright cannot parse is logged
   * once and skipped, so a typo costs the mask, not the capture.
   */
  private async maskLocators(page: Page, url: string): Promise<{ locators: Locator[]; count: number }> {
    const locators: Locator[] = [];
    let count = 0;
    for (const selector of this.config.maskSelectors) {
      if (this.badMasks.has(selector)) continue;
      const locator = page.locator(selector);
      try {
        const n = await locator.count();
        if (n > 0) {
          locators.push(locator);
          count += n;
        }
      } catch (err) {
        this.badMasks.add(selector);
        this.log(`capture ${url}: maskSelectors entry ${JSON.stringify(selector)} is not a valid selector (${(err as Error).message.split('\n')[0]}); ignored`);
      }
    }
    return { locators, count };
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}

/** Undo {@link prepareScript} so a scenario can go on from the same page: its style elements and grow attributes. */
const UNPREPARE_SCRIPT = `(() => {
  for (const style of document.querySelectorAll('style[data-visual-proof]')) style.remove();
  for (const el of document.querySelectorAll('[data-vp-grow], [data-vp-flow]')) {
    el.removeAttribute('data-vp-grow');
    el.removeAttribute('data-vp-flow');
  }
})()`;

/** A login-needed symptom in a finished capture, or null. */
function authProblem(requestedUrl: string, result: { httpStatus: number | null; finalUrl: string }): string | null {
  if (result.httpStatus === 401 || result.httpStatus === 403) return `HTTP ${result.httpStatus}`;
  try {
    const requested = new URL(requestedUrl);
    const final = new URL(result.finalUrl);
    if (final.pathname !== requested.pathname && LOGIN_PATH.test(final.pathname) && !LOGIN_PATH.test(requested.pathname)) {
      return `redirected to ${final.pathname}`;
    }
  } catch {
    // Unparseable URL (e.g. chrome-error://): not an auth symptom.
  }
  return null;
}

// NOTE: the scripts below are strings on purpose. Under tsx/esbuild `keepNames`, functions passed to
// `page.evaluate` get `__name(...)` helper calls injected that do not exist in the page, which throws
// a ReferenceError there. Strings are immune to any transpiler.

/** Fonts loaded and two animation frames painted, each with a cap so a hung page cannot stall a capture. */
async function settle(page: Page): Promise<boolean> {
  return page
    .evaluate(`(async () => {
      const cap = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(resolve, ms))]);
      await cap(document.fonts.ready, 3000);
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      await cap(frame().then(frame), 1000);
      return true;
    })()`)
    .then(() => true)
    .catch(() => false);
}

/** Absolute `href` of every `a[href]`, in DOM order (the `href` property resolves relative links and honours `<base>`). */
const LINKS_SCRIPT = `Array.from(document.querySelectorAll('a[href]')).map((a) => a.href).filter((href) => typeof href === 'string' && href !== '')`;

interface Dom {
  appRootPresent: boolean;
  appRootChildCount: number;
  visibleSpinnerCount: number;
  text: string;
  /** Like `text`, with the larger {@link SIDECAR_TEXT_LIMIT} cut. */
  fullText: string;
}

function emptyDom(): Dom {
  return { appRootPresent: false, appRootChildCount: 0, visibleSpinnerCount: 0, text: '', fullText: '' };
}

/** Null when the page navigated away mid-read (execution context destroyed). */
async function readDom(
  page: Page,
  appRoot: string,
  spinnerSelectors: string[],
  onError: (message: string) => void = () => {},
): Promise<Dom | null> {
  const script = `(() => {
    const appRoot = ${JSON.stringify(appRoot)};
    const spinnerSelectors = ${JSON.stringify(spinnerSelectors)};
    const limit = ${TEXT_EXCERPT_LIMIT};
    const fullLimit = ${SIDECAR_TEXT_LIMIT};
    const isVisible = (el) => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    let root = null;
    try {
      root = document.querySelector(appRoot);
    } catch (e) {
      root = null;
    }
    let spinners = 0;
    for (const selector of spinnerSelectors) {
      try {
        for (const el of document.querySelectorAll(selector)) if (isVisible(el)) spinners++;
      } catch (e) {
        // Invalid selector in config: ignore it rather than failing the capture.
      }
    }
    const text = root instanceof HTMLElement ? root.innerText.replace(/\\s+/g, ' ').trim() : '';
    return {
      appRootPresent: root !== null,
      appRootChildCount: root ? root.childElementCount : 0,
      visibleSpinnerCount: spinners,
      text: text.slice(0, limit),
      fullText: text.slice(0, fullLimit),
    };
  })()`;
  try {
    return (await page.evaluate(script)) as Dom;
  } catch (err) {
    onError((err as Error).message.split('\n')[0] ?? 'evaluate failed');
    return null;
  }
}

/** A page with the listeners every capture needs; the counters keep growing while it is open. */
interface Watched {
  page: Page;
  network: NetworkIdle;
  consoleErrors: string[];
  pageErrors: string[];
  /** Main-frame navigations so far, the initial one included. */
  navigations: number;
}

/** Mutable state of one running scenario. */
interface ScenarioRun {
  plan: ScenarioPlan;
  watched: Watched;
  stills: ScenarioStill[];
  executed: FrameStep[];
  /** Status of the latest document load; client-side navigation keeps it. */
  httpStatus: number | null;
  authFailure: string | undefined;
  deadline: number;
  stepTimeout: number;
  cancelled: boolean;
  failure: { line: number; text: string; reason: string } | undefined;
  current: SidecarStep | null;
  /** Set when the plan asked for a motion clip. */
  recorder: ScreenRecorder | undefined;
  /** How long each still shows in the clip (ms). */
  holdMs: number;
  /** Where the mouse is (viewport px); glides start here. */
  mouse: Point;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function failureOf(step: SidecarStep | null, reason: string): { line: number; text: string; reason: string } {
  return { line: step?.line ?? 0, text: step?.text ?? '', reason };
}

interface Loaded {
  /** Open; the caller closes it. */
  page: Page;
  navOk: boolean;
  httpStatus: number | null;
  dom: Dom;
  consoleErrors: string[];
  pageErrors: string[];
  /** Main-frame navigations after the first (Vite reloads, client-side redirects do not count). */
  extraNavigations: number;
  network: NetworkIdle;
  settleMs: number;
}

/**
 * In-flight request tracking for one page, started before it navigates. Playwright's own `networkidle` is a fixed
 * 500 ms quiet window; this one takes the window as a parameter.
 */
class NetworkIdle {
  private readonly inflight = new Set<Request>();
  private lastActivity = Date.now();

  constructor(page: Page) {
    const touch = (): void => {
      this.lastActivity = Date.now();
    };
    page.on('request', (request) => {
      this.inflight.add(request);
      touch();
    });
    const done = (request: Request): void => {
      this.inflight.delete(request);
      touch();
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
  }

  /** Resolves true once nothing has been in flight for `idleMs`, false when `maxMs` ran out first. */
  async wait(idleMs: number, maxMs: number): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    for (;;) {
      const now = Date.now();
      if (now >= deadline) return false;
      let pause = IDLE_POLL_MS;
      if (this.inflight.size === 0) {
        const quiet = now - this.lastActivity;
        if (quiet >= idleMs) return true;
        pause = idleMs - quiet;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pause, deadline - now)));
    }
  }
}

const IDLE_POLL_MS = 10;

interface Prepared {
  hidden: number;
  /** Description of the scroll container that was found, or null. */
  container: string | null;
  containerMissing: boolean;
  grew: boolean;
  fullHeight: number;
  lazyImages: number;
}

const MEASURE_SCRIPT = `(() => {
  const doc = document.scrollingElement || document.documentElement;
  return Math.ceil(Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0));
})()`;

/**
 * In-page script behind {@link Browser.preparePage}. Order matters: hide overlays first (so a hidden
 * overlay cannot be picked as the scroller), then find the scroller, then let it and its ancestors grow.
 */
export function prepareScript(hideSelectors: string[], scrollContainer: string | null): string {
  return `(() => {
    const hideSelectors = ${JSON.stringify(hideSelectors)};
    const override = ${JSON.stringify(scrollContainer)};
    const result = { hidden: 0, container: null, containerMissing: false, grew: false, fullHeight: 0, lazyImages: 0 };

    const valid = [];
    for (const selector of hideSelectors) {
      try {
        result.hidden += document.querySelectorAll(selector).length;
        valid.push(selector);
      } catch (e) {
        // Invalid selector in config: ignore it rather than failing the capture.
      }
    }
    const style = document.createElement('style');
    style.setAttribute('data-visual-proof', '');
    // "sel *" as well: a child that sets visibility: visible would otherwise show through a hidden parent.
    style.textContent = valid.map((s) => s + ', ' + s + ' * { visibility: hidden !important; }').join('\\n');
    if (valid.length > 0) (document.head || document.documentElement).appendChild(style);

    const doc = document.scrollingElement || document.documentElement;
    const docOverflow = doc.scrollHeight - window.innerHeight;
    const scrolls = (el) => /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);

    let best = null;
    let bestOverflow = 0;
    if (override) {
      try {
        best = document.querySelector(override);
      } catch (e) {
        best = null;
      }
      if (best) bestOverflow = best.scrollHeight - best.clientHeight;
      else result.containerMissing = true;
    } else {
      const candidates = [document.body, ...document.body.querySelectorAll('*')];
      for (const el of candidates) {
        if (!el) continue;
        const overflow = el.scrollHeight - el.clientHeight;
        if (overflow <= 1 || overflow <= bestOverflow) continue;
        // A page scroller is big: skip code blocks, sidebars, dropdown lists and textareas.
        if (el.clientWidth < window.innerWidth * 0.5 || el.clientHeight < window.innerHeight * 0.25) continue;
        if (!scrolls(el)) continue;
        best = el;
        bestOverflow = overflow;
      }
    }

    const describe = (el) => {
      let text = el.tagName.toLowerCase();
      if (el.id) text += '#' + el.id;
      else if (typeof el.className === 'string' && el.className.trim()) text += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
      return text;
    };

    if (best && best !== doc && bestOverflow > Math.max(1, docOverflow)) {
      for (let el = best; el && el !== document.documentElement; el = el.parentElement) {
        el.setAttribute('data-vp-grow', '');
        const position = getComputedStyle(el).position;
        // Out-of-flow ancestors (a fixed app shell) would not make the document any taller.
        if (position === 'fixed' || position === 'absolute') el.setAttribute('data-vp-flow', '');
      }
      const grow = document.createElement('style');
      grow.setAttribute('data-visual-proof', '');
      grow.textContent =
        'html, body, [data-vp-grow] { height: auto !important; max-height: none !important; overflow: visible !important; }\\n' +
        '[data-vp-flow] { position: relative !important; inset: auto !important; }';
      (document.head || document.documentElement).appendChild(grow);
      result.container = describe(best);
      result.grew = true;
    }

    for (const img of document.querySelectorAll('img[loading="lazy"]')) {
      img.loading = 'eager';
      result.lazyImages++;
    }

    result.fullHeight = Math.ceil(Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0));
    return result;
  })()`;
}

/** 1x1 transparent PNG, used only when a screenshot cannot be taken at all. */
const BLANK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
