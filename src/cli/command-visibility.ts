const INTERNAL_COMMANDS = {
  env: { hidden: true },
  runs: { internal: true }
} as const;

export type InternalCommandRoot = keyof typeof INTERNAL_COMMANDS;

export const INTERNAL_COMMAND_HELP = 'Use bazhuayu --help to view available commands';

export function isInternalCommandRoot(command: string): command is InternalCommandRoot {
  return Object.hasOwn(INTERNAL_COMMANDS, command);
}

export function internalCommandMetadata(command: InternalCommandRoot): { hidden?: true; internal?: true } {
  return INTERNAL_COMMANDS[command];
}
