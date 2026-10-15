#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runWatch, startDaemon, stopDaemon } from './daemon.js';
import { doctorCommand } from './doctor.js';
import { EXIT } from './exit.js';
import { finishCommand } from './finish.js';
import { beforeCommand } from './before.js';
import { classifyCommand } from './classify.js';
import { sidecarTryCommand } from './sidecar-try.js';
import { pathsInfo, resolveDirs } from './paths.js';
// v0.8 dynamic params: `params set|list|clear` lives in params.ts.
import { DEFAULT_SET_TIMEOUT_S, PARAMS_ACTIONS, paramsCommand, type ParamsAction } from './params.js';
import { DEFAULT_READY_TIMEOUT_S, waitForReady } from './ready.js';
import { readLiveStatus } from './status.js';
import { firstLine } from './text.js';

export type Command = 'start' | 'stop' | 'status' | 'ready' | 'watch' | 'finish' | 'before' | 'doctor' | 'params' | 'classify' | 'sidecar';

const COMMANDS: readonly Command[] = ['start', 'stop', 'status', 'ready', 'watch', 'finish', 'before', 'doctor', 'params', 'classify', 'sidecar'];
const SIDECAR_ACTIONS = ['try'] as const;

export { readLiveStatus };

export interface ParsedArgs {
  command: Command | null;
  configPath?: string;
  hook: boolean;
  json: boolean;
  /** `doctor --json --normalize`: strip machine-specific details from the report. */
  normalize: boolean;
  /** `doctor --probe-decisions`: probe the decisions models even when the app is not up. */
  probeDecisions: boolean;
  /** `status --wait` (and the `ready` command): block until the watcher is ready. */
  wait: boolean;
  /** Seconds `--wait` may block; undefined means the default. */
  timeoutSec?: number;
  help: boolean;
  /** `params`: the action (set, list, clear) and its positional arguments. */
  paramsAction?: ParamsAction;
  paramsArgs: string[];
  /** v0.13 `ready --claim`, `status --wait --claim`: wait for the claim screens only. `before --claim`: capture them. */
  claim: boolean;
  /** v0.13 `before --working-tree-sidecars`: replay sidecars as they are on disk. */
  workingTreeSidecars: boolean;
  /** v0.13 `classify`: the paths to classify (none: the branch's changed files). */
  paths: string[];
  /** v0.13 `sidecar try <file>`. */
  sidecarAction?: (typeof SIDECAR_ACTIONS)[number];
  sidecarFile?: string;
}

export class UsageError extends Error {}

export const HELP = `visual-proof: visual proof capture for agent tasks

Usage: visual-proof <command> [options]

Commands:
  start      start the capture daemon (or reattach to the running one)
  stop       stop the capture daemon
  status     print the daemon status (--wait: block until it is ready)
  ready      alias for "status --wait" (--claim: until the claim screens are ready)
  watch      run the watcher in the foreground
  finish     assemble headline stills and the proof block for HEAD
  before     capture the headlines with the frontend at the merge-base, for finish's before/after pairs
             (--claim: the screens the claim names, even before any edit)
  doctor     check the browser, change trigger, barrier, login, routes, route params, sidecars and replay
  params     set, list or clear route params for this session (see below)
  classify   say whether files need visual proof (screen, backend or sidecar) and which screens they
             reach; without paths, the files changed on this branch
  sidecar try <file>
             replay one sidecar scenario now against the running app: each step's pass/fail with
             its line, the stills and the time; no watcher, commit or frame record

Options:
  --config <path>   config file (default: ./visual-proof.config.json)
  --hook            finish only: quiet, time-capped, always exits 0
  --json            finish, before, doctor, params list, classify, sidecar try: print the
                    result as JSON on stdout
  --normalize       doctor --json: strip ports, absolute paths, hashes, timings and
                    versions, so the report can be checked in as a golden file
  --probe-decisions doctor only: send one tiny request to each decisions model (needs
                    OPENROUTER_API_KEY); without it they are probed only when the app is up
  --wait            status: block until the watcher is ready with nothing pending
                    (exit 0), or fail fast on error / a dead watcher / stop (exit 1)
  --claim           status --wait, ready: return once every screen the claim names has a
                    clean frame at the current tree, ignoring impact routes and later
                    batches; fail fast when a claim screen is not clean or names nothing
                    before: capture the claim screens at the merge-base, whatever the diff
  --working-tree-sidecars
                    before: replay sidecars as they are on disk (uncommitted ones are
                    skipped otherwise)
  --timeout <s>     status --wait, ready: give up after this many seconds
                    (default ${DEFAULT_READY_TIMEOUT_S}); exit 1 with a one-line reason
                    params set: wait this long for the watcher's capture (default ${DEFAULT_SET_TIMEOUT_S})
  -h, --help        show this help

Route params (a route like /invoices/:id needs an id before it can be captured):
  params set <routeKey> key=value [key=value...]
                    use these values for the route, ahead of every other source;
                    a running watcher captures it at once (exit 2: unknown route key,
                    missing or extra params; exit 1: the capture was not clean)
  params list       what was set, what link discovery found, and the seed candidates
  params clear [<routeKey>]
                    drop one route's session params, or all of them
  Example: npx visual-proof params set '/invoices/:id' id=42

Output:
  start, status     one JSON object on stdout: the daemon status plus
                    paths { statusDir, proofBlock, log, doctor }
  finish            the proof block path on stdout (always, even for "no screen
                    changes"); failures and remedy hints on stderr.
                    --json prints the whole result instead; --hook prints one
                    summary line
  doctor            a table ending in "details: <doctor.json path>";
                    --json prints the report instead
  classify          one line per file (screen, backend, sidecar or none, and the screens it
                    reaches), then "needs proof: yes|no"; --json: { needsProof, files, screens }
  sidecar try       one line per step (ok, FAIL with the reason, skip), the still paths
                    (under the scratch dir) and a summary

Files (in $VISUAL_PROOF_STATUS_DIR, default /tmp/cursor/visual-proof):
  status.json       daemon state, warm-up, pending work (remaining: claim, headline,
                    impact), claim readiness per claim screen, anchor, lastError, lastFinish
  claim-request.json    written by ready --claim and finish: capture the claim screens first
  session-params.json   route params set with "params set" (never committed)
  param-discovery.json  ids link discovery found this watcher session
  anchors.json      diff anchor per repo and branch (kept across daemon restarts)
  proof-block.md    what finish last wrote, success or failure
  watcher.log       one line per event
  doctor.json       the last doctor report
  Headline stills and replay-<shortTree>.mp4 (needs ffmpeg) go to $VISUAL_PROOF_ARTIFACT_DIR
  (default /opt/cursor/artifacts).

Exit codes:
  0   ok (finish: every changed screen has a clean frame at HEAD, or there are none;
      status --wait / ready: the watcher is ready)
  1   finish: proof failures, listed on stderr and in the proof block
      before: a headline could not be captured at the merge-base
      status --wait / ready: not ready (one line on stderr with the reason, what is
      still outstanding and the paths)
      sidecar try: a step failed or a still is not clean
      doctor: the browser or the change trigger is missing
  2   usage error
  3   setup or config error (invalid config, not a git repo, the watcher cannot start)
  4   internal error
  (stop returns 4 if the daemon cannot be signalled; finish --hook always returns 0)

Examples:
  visual-proof start --config ./visual-proof.config.json
  visual-proof before --claim &       # while you code: the claim screens at the merge-base
  visual-proof ready --claim          # after a save: the claim screens are captured
  visual-proof sidecar try .visual-proof/sidecars/refund.vp
  visual-proof finish    # after committing; exit 0 means proof-block.md is ready to paste
`;

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: null,
    hook: false,
    json: false,
    normalize: false,
    probeDecisions: false,
    wait: false,
    help: false,
    paramsArgs: [],
    claim: false,
    workingTreeSidecars: false,
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
    } else if (arg === '--hook') {
      parsed.hook = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--normalize') {
      parsed.normalize = true;
    } else if (arg === '--probe-decisions') {
      parsed.probeDecisions = true;
    } else if (arg === '--wait') {
      parsed.wait = true;
    } else if (arg === '--claim') {
      parsed.claim = true;
    } else if (arg === '--working-tree-sidecars') {
      parsed.workingTreeSidecars = true;
    } else if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      const value = arg === '--timeout' ? argv[++i] : arg.slice('--timeout='.length);
      const seconds = value === undefined || value === '' ? Number.NaN : Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError('--timeout requires a positive number of seconds');
      parsed.timeoutSec = seconds;
    } else if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length);
      if (!value) throw new UsageError('--config requires a path');
      parsed.configPath = value;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option: ${arg}`);
    } else if (parsed.command === 'classify') {
      parsed.paths.push(arg);
    } else if (parsed.command === 'sidecar') {
      if (parsed.sidecarAction === undefined) {
        if (!(SIDECAR_ACTIONS as readonly string[]).includes(arg)) throw new UsageError(`unknown sidecar action: ${arg} (expected try)`);
        parsed.sidecarAction = arg as ParsedArgs['sidecarAction'];
      } else if (parsed.sidecarFile === undefined) {
        parsed.sidecarFile = arg;
      } else {
        throw new UsageError(`sidecar try takes one file, got another: ${arg}`);
      }
    } else if (parsed.command === 'params') {
      if (parsed.paramsAction === undefined) {
        if (!(PARAMS_ACTIONS as readonly string[]).includes(arg)) throw new UsageError(`unknown params action: ${arg} (expected set, list or clear)`);
        parsed.paramsAction = arg as ParamsAction;
      } else {
        parsed.paramsArgs.push(arg);
      }
    } else if (parsed.command !== null) {
      throw new UsageError(`unexpected argument: ${arg}`);
    } else if ((COMMANDS as readonly string[]).includes(arg)) {
      parsed.command = arg as Command;
    } else {
      throw new UsageError(`unknown command: ${arg}`);
    }
  }
  if (parsed.hook && parsed.command !== 'finish' && !parsed.help) {
    throw new UsageError('--hook is only valid with the finish command');
  }
  const jsonCommands: Array<Command | null> = ['finish', 'before', 'doctor', 'classify', 'sidecar'];
  if (parsed.json && !jsonCommands.includes(parsed.command) && !(parsed.command === 'params' && parsed.paramsAction === 'list') && !parsed.help) {
    throw new UsageError('--json is only valid with the finish, before, doctor, params list, classify and sidecar try commands');
  }
  if (parsed.claim && !parsed.help && !((parsed.command === 'status' && parsed.wait) || parsed.command === 'ready' || parsed.command === 'before')) {
    throw new UsageError('--claim is only valid with status --wait, ready and before');
  }
  if (parsed.workingTreeSidecars && parsed.command !== 'before' && !parsed.help) {
    throw new UsageError('--working-tree-sidecars is only valid with the before command');
  }
  if (parsed.command === 'sidecar' && !parsed.help) {
    if (parsed.sidecarAction === undefined) throw new UsageError('sidecar needs an action: try <file>');
    if (parsed.sidecarFile === undefined) throw new UsageError('sidecar try needs a sidecar file, e.g. sidecar try .visual-proof/sidecars/refund.vp');
  }
  if (parsed.normalize && !parsed.help && (parsed.command !== 'doctor' || !parsed.json)) {
    throw new UsageError('--normalize is only valid with doctor --json');
  }
  if (parsed.probeDecisions && parsed.command !== 'doctor' && !parsed.help) {
    throw new UsageError('--probe-decisions is only valid with the doctor command');
  }
  if (parsed.wait && parsed.command !== 'status' && parsed.command !== 'ready' && !parsed.help) {
    throw new UsageError('--wait is only valid with the status command');
  }
  if (parsed.timeoutSec !== undefined && !(parsed.wait || parsed.command === 'ready' || (parsed.command === 'params' && parsed.paramsAction === 'set')) && !parsed.help) {
    throw new UsageError('--timeout is only valid with status --wait, ready or params set');
  }
  if (parsed.command === 'params' && !parsed.help) {
    const { paramsAction: action, paramsArgs: rest } = parsed;
    if (action === undefined) throw new UsageError('params needs an action: set, list or clear');
    if (action === 'set' && rest.length < 2) throw new UsageError("params set needs a route key and at least one param=value, e.g. params set '/invoices/:id' id=5");
    if (action === 'list' && rest.length > 0) throw new UsageError(`params list takes no arguments, got: ${rest.join(' ')}`);
    if (action === 'clear' && rest.length > 1) throw new UsageError(`params clear takes at most one route key, got: ${rest.join(' ')}`);
  }
  return parsed;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`visual-proof: ${err.message}\n\n${HELP}`);
    return EXIT.USAGE;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }
  if (args.command === null) {
    process.stderr.write(HELP);
    return EXIT.USAGE;
  }

  try {
    if (args.command === 'ready' || (args.command === 'status' && args.wait)) {
      return await waitForReady({ dirs: resolveDirs(env), timeoutSec: args.timeoutSec, claim: args.claim });
    }
    if (args.command === 'status') return printStatus(env);
    if (args.command === 'start') return await startDaemon({ configPath: args.configPath, env });
    if (args.command === 'stop') return await stopDaemon({ configPath: args.configPath, env });
    if (args.command === 'watch') return await runWatch({ configPath: args.configPath, env });
    if (args.command === 'finish') {
      return await finishCommand({ configPath: args.configPath, hook: args.hook, json: args.json, env });
    }
    if (args.command === 'before') {
      return await beforeCommand({ configPath: args.configPath, json: args.json, claim: args.claim, workingTreeSidecars: args.workingTreeSidecars, env });
    }
    if (args.command === 'classify') return await classifyCommand({ configPath: args.configPath, paths: args.paths, json: args.json, env });
    if (args.command === 'sidecar') return await sidecarTryCommand({ configPath: args.configPath, file: args.sidecarFile!, json: args.json, env });
    if (args.command === 'params') {
      return await paramsCommand({ configPath: args.configPath, action: args.paramsAction!, args: args.paramsArgs, json: args.json, timeoutSec: args.timeoutSec, env });
    }
    return await doctorCommand({
      configPath: args.configPath,
      json: args.json,
      normalize: args.normalize,
      env,
      ...(args.probeDecisions ? { options: { probeDecisions: true } } : {}),
    });
  } catch (err) {
    process.stderr.write(`visual-proof ${args.command}: internal error: ${firstLine(err)}\n`);
    return EXIT.INTERNAL;
  }
}

function printStatus(env: NodeJS.ProcessEnv): number {
  const dirs = resolveDirs(env);
  process.stdout.write(`${JSON.stringify({ ...readLiveStatus(dirs), paths: pathsInfo(dirs) })}\n`);
  return EXIT.OK;
}

const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : null;
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const argv = process.argv.slice(2);
  const code = await main(argv);
  process.exitCode = code;
  // The foreground watcher owns a browser and sockets; do not let a stray handle keep it alive after shutdown.
  if (argv.includes('watch')) process.exit(code);
  // finish and doctor are time-boxed: a step that outlived its budget must not keep the process (or the agent) waiting.
  if (['finish', 'doctor', 'before', 'classify', 'sidecar'].some((command) => argv.includes(command))) {
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
    await new Promise<void>((resolve) => process.stderr.write('', () => resolve()));
    process.exit(code);
  }
}
