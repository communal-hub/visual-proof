import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser as PwBrowser, type BrowserContext, type Page } from 'playwright';
import type { Config } from './config.js';
import { normalizeRenderedFiles, renderedFilesScript } from './rendered.js';
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
}

export interface CaptureResult {
  png: Buffer;
  signals: CaptureSignals;
  /** URL the page ended on after redirects and client-side routing. */
  finalUrl: string;
  /** Absent from capturers that do not prepare the page (test fakes). */
  layout?: CaptureLayout;
  /** Component files mounted in the page (see {@link Frame.renderedFiles}); absent from fakes. */
  renderedFiles?: string[] | null;
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
  close(): Promise<void>;
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
  | 'ignoreHTTPSErrors'
  | 'viewport'
  | 'login'
  | 'appRoot'
  | 'spinnerSelectors'
  | 'scrollContainer'
  | 'maxCaptureHeight'
  | 'hideSelectors'
  | 'renderCheck'
>;

export interface BrowserOptions {
  log?: (message: string) => void;
  /** Navigation timeout. Default 30 s. */
  navigationTimeoutMs?: number;
  /** Cap on waiting for the network to go quiet. Default 5 s. */
  networkIdleCapMs?: number;
  /** After a login failure, skip new login attempts for this long and reuse the failure. Default 30 s. */
  loginBackoffMs?: number;
  /** Clock for the login back-off; tests inject a fake. */
  now?: () => number;
  /** Runs on the prepared page right before the screenshot (tests inspect what the still will show). */
  beforeScreenshot?: (page: Page) => Promise<void>;
}

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
  /** The last login failure and when it happened; reused (not retried) until the back-off passes. */
  private loginFailure: { error: LoginError; at: number } | null = null;
  private readonly pages = new Set<Page>();

  constructor(
    private readonly config: BrowserConfig,
    private readonly options: BrowserOptions = {},
  ) {}

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

    const { png, signals, finalUrl, layout, renderedFiles } = attempt;
    if (authFailure) signals.authFailure = authFailure;
    return { png, signals, finalUrl, ...(layout ? { layout } : {}), renderedFiles };
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.loggedIn = false;
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
    this.loginFailure = null;
    return this.context;
  }

  // ---- login ---------------------------------------------------------------

  private async ensureLoggedIn(): Promise<void> {
    if (this.config.login.type !== 'http-hook' || this.loggedIn) return;
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
  private async login(): Promise<void> {
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
        data: { email: login.email },
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
    this.log(`logged in as ${login.email}`);
  }

  // ---- capture -------------------------------------------------------------

  /**
   * Open a fresh page, navigate and wait for the app to settle. The page is returned open: the caller
   * screenshots it if it wants to and must close it.
   */
  private async loadPage(context: BrowserContext, url: string): Promise<Loaded> {
    const page = await context.newPage();
    this.pages.add(page);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
    let navigations = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });

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

      let dom = emptyDom();
      if (navOk) {
        // The page can navigate again on its own after `load` (Vite reloads when it re-optimizes
        // dependencies; apps redirect after a guard). Re-settle whenever that happens mid-stabilisation.
        for (let attempt = 0; attempt < 4; attempt++) {
          const seen = navigations;
          // Playwright's "networkidle" is a 500 ms quiet window; cap how long we are willing to wait for it.
          await page
            .waitForLoadState('networkidle', { timeout: this.options.networkIdleCapMs ?? 5000 })
            .catch(() => {});
          const settled = await settle(page);
          const read = settled
            ? await readDom(page, this.config.appRoot, this.config.spinnerSelectors, (m) =>
                this.log(`capture ${url}: reading the page failed: ${m}`),
              )
            : null;
          if (read && navigations === seen) {
            dom = read;
            break;
          }
          if (read) dom = read;
          this.log(`capture ${url}: page navigated while settling (attempt ${attempt + 1})`);
        }
      }
      return {
        page,
        navOk,
        httpStatus,
        dom,
        consoleErrors,
        pageErrors,
        // The initial navigation is the first one; anything after it is the page moving on its own.
        extraNavigations: Math.max(0, navigations - 1),
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
    try {
      let layout: CaptureLayout | undefined;
      let renderedFiles: string[] | null = null;
      if (navOk && this.config.renderCheck !== 'off') {
        renderedFiles = await page
          .evaluate(renderedFilesScript(this.config.appRoot))
          .then((raw) => normalizeRenderedFiles(raw as string[] | null, this.config.repoDir), () => null);
      }
      if (navOk) {
        try {
          layout = await this.preparePage(page, url);
        } catch (err) {
          this.log(`capture ${url}: preparing the page for the screenshot failed: ${(err as Error).message.split('\n')[0]}`);
        }
        await this.options.beforeScreenshot?.(page);
      }

      let screenshotError: string | undefined;
      const { width } = this.config.viewport;
      const png = await page
        .screenshot({
          fullPage: true,
          // Keep the viewport width and cut the height at the cap, whatever overflows horizontally or below.
          ...(layout ? { clip: { x: 0, y: 0, width, height: layout.height } } : {}),
          type: 'png',
          animations: 'disabled',
          caret: 'hide',
        })
        .catch((err: Error) => {
          screenshotError = err.message.split('\n')[0] || err.name;
          this.log(`capture ${url}: screenshot failed: ${screenshotError}`);
          return Buffer.from(BLANK_PNG_BASE64, 'base64');
        });

      return {
        png,
        finalUrl: page.url(),
        httpStatus,
        ...(layout ? { layout } : {}),
        renderedFiles,
        signals: { navOk, httpStatus, consoleErrors, pageErrors, ...dom, ...(screenshotError ? { screenshotError } : {}) },
      };
    } finally {
      this.pages.delete(page);
      await page.close().catch(() => {});
    }
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

  /**
   * Make the page look the way the still should: hide dev overlays, let an inner scroll container grow the
   * document so a full-page screenshot sees all of its content, and work out how tall the still will be.
   * The page is closed after the capture, so nothing is undone.
   */
  private async preparePage(page: Page, url: string): Promise<CaptureLayout> {
    const { hideSelectors, scrollContainer, maxCaptureHeight } = this.config;
    const prepared = (await page.evaluate(prepareScript(hideSelectors, scrollContainer ?? null))) as Prepared;
    if (scrollContainer && prepared.containerMissing) {
      this.log(`capture ${url}: scrollContainer ${JSON.stringify(scrollContainer)} matched nothing; using the page as it is`);
    }
    let fullHeight = prepared.fullHeight;
    if (prepared.grew || prepared.lazyImages > 0) {
      // More of the page is on screen now: lazy images start loading, virtual lists render more rows.
      await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
      await settle(page);
      fullHeight = await page.evaluate(MEASURE_SCRIPT).then(Number, () => fullHeight);
    }
    const height = Math.min(Math.max(fullHeight, this.config.viewport.height), maxCaptureHeight);
    const capped = fullHeight > maxCaptureHeight;
    if (prepared.grew) {
      this.log(`capture ${url}: expanded scroll container ${prepared.container} to ${fullHeight}px`);
    }
    if (capped) this.log(`capture ${url}: page is ${fullHeight}px tall; cut off at maxCaptureHeight ${maxCaptureHeight}px`);
    return { scrollContainer: prepared.grew ? prepared.container : null, fullHeight, height, capped, hidden: prepared.hidden };
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}

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

interface Dom {
  appRootPresent: boolean;
  appRootChildCount: number;
  visibleSpinnerCount: number;
  text: string;
}

function emptyDom(): Dom {
  return { appRootPresent: false, appRootChildCount: 0, visibleSpinnerCount: 0, text: '' };
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
    };
  })()`;
  try {
    return (await page.evaluate(script)) as Dom;
  } catch (err) {
    onError((err as Error).message.split('\n')[0] ?? 'evaluate failed');
    return null;
  }
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
}

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
