import { hasFlag } from './args.js';
import { printEnvelope } from './output.js';
import { EXIT_OPERATION_FAILED } from '../types.js';

export function requireExplicitYes(args: string[], json: boolean, action: string, target: string): number | null {
  if (hasFlag(args, '--yes')) return null;
  const message = `${action} 会修改或删除远端资源: ${target}。确认后请重新执行并添加 --yes。`;
  if (json) {
    printEnvelope(false, undefined, 'CONFIRMATION_REQUIRED', message);
  } else {
    console.error(message);
  }
  return EXIT_OPERATION_FAILED;
}
