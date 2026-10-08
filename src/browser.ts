import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser as PwBrowser, type BrowserContext, type Page } from 'playwright';
import type { Config } from './config.js';
import type { TriageSignals } from './triage.js';

/** Max characters of app-root text kept on a capture. */
export const TEXT_EXCERPT_LIMIT = 2048;

export interface CaptureSignals extends TriageSignals {
  /** `innerText` of the app root, trimmed and cut to {@link TEXT_EXCERPT_LIMIT} characters. */
  text: string;
}

export interface CaptureResult {
  png: Buffer;
  signals: CaptureSignals;
  /** URL the page ended on after redirects and client-side routing. */
  finalUrl: string;
}

/** What `watch` needs from a browser; lets tests inject a fake. */
export interface Capturer {
  /** Best-effort early login so the first capture is not slower than the rest. */
  warm(): Promise<void>;
  capture(url: string): Promise<CaptureResult>;
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
  'repoDir' | 'appUrl' | 'ignoreHTTPSErrors' | 'viewport' | 'login' | 'appRoot' | 'spinnerSelectors'
>;

export interface BrowserOptions {
  log?: (message: string) => void;
  /** Navigation timeout. Default 30 s. */
  navigationTimeoutMs?: number;
  /** Cap on waiting for the network to go quiet. Default 5 s. */
  networkIdleCapMs?: number;
}

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

    const { png, signals, finalUrl } = attempt;
    if (authFailure) signals.authFailure = authFailure;
    return { png, signals, finalUrl };
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.loggedIn = false;
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
    return this.context;
  }

  // ---- login ---------------------------------------------------------------

  private async ensureLoggedIn(): Promise<void> {
    if (this.config.login.type !== 'http-hook' || this.loggedIn) return;
    await this.login();
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

  private async captureOnce(context: BrowserContext, url: string): Promise<CaptureResult & { httpStatus: number | null }> {
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
      const png = await page
        .screenshot({ fullPage: true, type: 'png', animations: 'disabled', caret: 'hide' })
        .catch((err: Error) => {
          this.log(`capture ${url}: screenshot failed: ${err.message.split('\n')[0]}`);
          return Buffer.from(BLANK_PNG_BASE64, 'base64');
        });

      return {
        png,
        finalUrl: page.url(),
        httpStatus,
        signals: { navOk, httpStatus, consoleErrors, pageErrors, ...dom },
      };
    } finally {
      this.pages.delete(page);
      await page.close().catch(() => {});
    }
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

/** 1x1 transparent PNG, used only when a screenshot cannot be taken at all. */
const BLANK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
