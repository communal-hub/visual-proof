#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runWatch, startDaemon, stopDaemon } from './daemon.js';
import { resolveDirs, statusFiles } from './paths.js';

export type Command = 'start' | 'stop' | 'status' | 'watch' | 'finish' | 'doctor';

const COMMANDS: readonly Command[] = ['start', 'stop', 'status', 'watch', 'finish', 'doctor'];

export interface ParsedArgs {
  command: Command | null;
  configPath?: string;
  hook: boolean;
  help: boolean;
}

export class UsageError extends Error {}

export const HELP = `visual-proof: visual proof capture for agent tasks

Usage: visual-proof <command> [options]

Commands:
  start      start the capture daemon
  stop       stop the capture daemon
  status     print the daemon status
  watch      run the watcher in the foreground
  finish     assemble headline stills and the proof block (--hook: quiet backstop mode)
  doctor     check the browser and change trigger

Options:
  --config <path>   config file (default: ./visual-proof.config.json)
  --hook            finish only: quiet, time-capped, always exits 0
  -h, --help        show this help
`;

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: null, hook: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
    } else if (arg === '--hook') {
      parsed.hook = true;
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
  return parsed;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`visual-proof: ${err.message}\n\n${HELP}`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.command === null) {
    process.stderr.write(HELP);
    return 2;
  }
  if (args.command === 'status') return printStatus(env);
  if (args.command === 'start') return startDaemon({ configPath: args.configPath, env });
  if (args.command === 'stop') return stopDaemon({ configPath: args.configPath, env });
  if (args.command === 'watch') return runWatch({ configPath: args.configPath, env });

  process.stderr.write(`visual-proof ${args.command}: not implemented\n`);
  return 2;
}

function printStatus(env: NodeJS.ProcessEnv): number {
  const file = statusFiles(resolveDirs(env)).status;
  try {
    process.stdout.write(fs.readFileSync(file, 'utf8').trimEnd() + '\n');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    process.stdout.write(`${JSON.stringify({ state: 'stopped' })}\n`);
  }
  return 0;
}

const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : null;
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const argv = process.argv.slice(2);
  const code = await main(argv);
  process.exitCode = code;
  // The foreground watcher owns a browser and sockets; do not let a stray handle keep it alive after shutdown.
  if (argv.includes('watch')) process.exit(code);
}
