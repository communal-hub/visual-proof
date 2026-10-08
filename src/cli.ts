#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runWatch, startDaemon, stopDaemon } from './daemon.js';
import { doctorCommand } from './doctor.js';
import { EXIT } from './exit.js';
import { finishCommand } from './finish.js';
import { pathsInfo, resolveDirs, statusFiles, type Dirs } from './paths.js';
import { readStatusFile, watcherPid } from './status.js';
import { firstLine } from './text.js';

export type Command = 'start' | 'stop' | 'status' | 'watch' | 'finish' | 'doctor';

const COMMANDS: readonly Command[] = ['start', 'stop', 'status', 'watch', 'finish', 'doctor'];

export interface ParsedArgs {
  command: Command | null;
  configPath?: string;
  hook: boolean;
  json: boolean;
  help: boolean;
}

export class UsageError extends Error {}

export const HELP = `visual-proof: visual proof capture for agent tasks

Usage: visual-proof <command> [options]

Commands:
  start      start the capture daemon (or reattach to the running one)
  stop       stop the capture daemon
  status     print the daemon status
  watch      run the watcher in the foreground
  finish     assemble headline stills and the proof block for HEAD
  doctor     check the browser, change trigger, barrier, login and routes

Options:
  --config <path>   config file (default: ./visual-proof.config.json)
  --hook            finish only: quiet, time-capped, always exits 0
  --json            finish, doctor: print the result as JSON on stdout
  -h, --help        show this help

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
  status.json       daemon state, pending work, anchor, lastError, lastFinish
  proof-block.md    what finish last wrote, success or failure
  watcher.log       one line per event
  doctor.json       the last doctor report
  Headline stills go to $VISUAL_PROOF_ARTIFACT_DIR (default /opt/cursor/artifacts).

Exit codes:
  0   ok (finish: every changed screen has a clean frame at HEAD, or there are none)
  1   finish: proof failures, listed on stderr and in the proof block
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
  const parsed: ParsedArgs = { command: null, hook: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
    } else if (arg === '--hook') {
      parsed.hook = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length);
      if (!value) throw new UsageError('--config requires a path');
      parsed.configPath = value;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option: ${arg}`);
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
  if (parsed.json && parsed.command !== 'finish' && parsed.command !== 'doctor' && !parsed.help) {
    throw new UsageError('--json is only valid with the finish and doctor commands');
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
    if (args.command === 'status') return printStatus(env);
    if (args.command === 'start') return await startDaemon({ configPath: args.configPath, env });
    if (args.command === 'stop') return await stopDaemon({ configPath: args.configPath, env });
    if (args.command === 'watch') return await runWatch({ configPath: args.configPath, env });
    if (args.command === 'finish') {
      return await finishCommand({ configPath: args.configPath, hook: args.hook, json: args.json, env });
    }
    return await doctorCommand({ configPath: args.configPath, json: args.json, env });
  } catch (err) {
    process.stderr.write(`visual-proof ${args.command}: internal error: ${firstLine(err)}\n`);
    return EXIT.INTERNAL;
  }
}

const RUNNING_STATES = ['starting', 'ready', 'capturing'];

/**
 * The status file as it should be read: a status that claims the watcher is running while its
 * process is gone (killed, crashed, rebooted) is reported as stopped and stale rather than trusted.
 */
export function readLiveStatus(dirs: Dirs): Record<string, unknown> {
  const stored = readStatusFile(statusFiles(dirs).status);
  if (stored === null) return { state: 'stopped' };
  if (RUNNING_STATES.includes(stored.state as string) && watcherPid(dirs, stored) === null) {
    return {
      ...stored,
      state: 'stopped',
      stale: true,
      pending: false,
      lastError: 'watcher exited without stopping',
    };
  }
  return { ...stored };
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
