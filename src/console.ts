/** Serializable rules: the watcher and independently launched replays read the same config. */
export interface ConsoleConfig {
  ignore: Array<{ message: string; sourceUrl?: string }>;
  ignoreThirdPartyCsp: boolean;
}

/** Unknown sources and errors from the app origin are never covered by the built-in CSP rule. */
export function consoleErrorFilter(config: ConsoleConfig, appUrl: string): (message: string, sourceUrl: string) => boolean {
  const rules = config.ignore.map((rule) => ({ message: new RegExp(rule.message), sourceUrl: rule.sourceUrl ? new RegExp(rule.sourceUrl) : undefined }));
  const appOrigin = new URL(appUrl).origin;
  return (message, sourceUrl) => {
    if (rules.some((rule) => rule.message.test(message) && (!rule.sourceUrl || rule.sourceUrl.test(sourceUrl)))) return true;
    if (!config.ignoreThirdPartyCsp || !/(?:Refused to apply inline style|Applying inline style violates)/i.test(message) || !/content security policy/i.test(message)) return false;
    try {
      const source = new URL(sourceUrl);
      return ['http:', 'https:'].includes(source.protocol) && source.origin !== appOrigin;
    } catch {
      return false;
    }
  };
}
