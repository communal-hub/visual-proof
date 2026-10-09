#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runWatch, startDaemon, stopDaemon } from './daemon.js';
import { doctorCommand } from './doctor.js';
import { EXIT } from './exit.js';
import { finishCommand } from './finish.js';
import { pathsInfo, resolveDirs } from './paths.js';
// v0.8 dynamic params: `params set|list|clear` lives in params.ts.
import { DEFAULT_SET_TIMEOUT_S, PARAMS_ACTIONS, paramsCommand, type ParamsAction } from './params.js';
import { DEFAULT_READY_TIMEOUT_S, waitForReady } from './ready.js';
import { readLiveStatus } from './status.js';
import { firstLine } from './text.js';

export type Command = 'start' | 'stop' | 'status' | 'ready' | 'watch' | 'finish' | 'doctor' | 'params';

const COMMANDS: readonly Command[] = ['start', 'stop', 'status', 'ready', 'watch', 'finish', 'doctor', 'params'];

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
}

export class UsageError extends Error {}

export const HELP = `visual-proof: visual proof capture for agent tasks

Usage: visual-proof <command> [options]

Commands:
  start      start the capture daemon (or reattach to the running one)
  stop       stop the capture daemon
  status     print the daemon status (--wait: block until it is ready)
  ready      alias for "status --wait"
  watch      run the watcher in the foreground
  finish     assemble headline stills and the proof block for HEAD
  doctor     check the browser, change trigger, barrier, login, routes, route params, sidecars and replay
  params     set, list or clear route params for this session (see below)

Options:
  --config <path>   config file (default: ./visual-proof.config.json)
  --hook            finish only: quiet, time-capped, always exits 0
  --json            finish, doctor, params list: print the result as JSON on stdout
  --normalize       doctor --json: strip ports, absolute paths, hashes, timings and
                    versions, so the report can be checked in as a golden file
  --probe-decisions doctor only: send one tiny request to each decisions model (needs
                    OPENROUTER_API_KEY); without it they are probed only when the app is up
  --wait            status: block until the watcher is ready with nothing pending
                    (exit 0), or fail fast on error / a dead watcher / stop (exit 1)
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

Files (in $VISUAL_PROOF_STATUS_DIR, default /tmp/cursor/visual-proof):
  status.json       daemon state, warm-up, pending work, anchor, lastError, lastFinish
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
      status --wait / ready: not ready (one line on stderr with the reason and paths)
      doctor: the browser or the change trigger is missing
  2   usage error
  3   setup or config error (invalid config, not a git repo, the watcher cannot start)
  4   internal error
  (stop returns 4 if the daemon cannot be signalled; finish --hook always returns 0)

Examples:
  visual-proof start --config ./visual-proof.config.json
  visual-proof finish    # after committing; exit 0 means proof-block.md is ready to paste
`;

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: null, hook: false, json: false, normalize: false, probeDecisions: false, wait: false, help: false, paramsArgs: [] };
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
  if (parsed.json && parsed.command !== 'finish' && parsed.command !== 'doctor' && !(parsed.command === 'params' && parsed.paramsAction === 'list') && !parsed.help) {
    throw new UsageError('--json is only valid with the finish, doctor and params list commands');
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
      return await waitForReady({ dirs: resolveDirs(env), timeoutSec: args.timeoutSec });
    }
    if (args.command === 'status') return printStatus(env);
    if (args.command === 'start') return await startDaemon({ configPath: args.configPath, env });
    if (args.command === 'stop') return await stopDaemon({ configPath: args.configPath, env });
    if (args.command === 'watch') return await runWatch({ configPath: args.configPath, env });
    if (args.command === 'finish') {
      return await finishCommand({ configPath: args.configPath, hook: args.hook, json: args.json, env });
    }
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
  if (argv.includes('finish') || argv.includes('doctor')) {
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
    await new Promise<void>((resolve) => process.stderr.write('', () => resolve()));
    process.exit(code);
  }
}
