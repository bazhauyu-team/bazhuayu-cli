import { writeFile } from 'node:fs/promises';
import { valueAfter } from '../../cli/args.js';
import { resolveAuth } from '../../runtime/auth.js';
import { saveDetectedTaskToCloud, type CloudSavableTask } from '../../runtime/task-cloud-save.js';

export const SKIP_DETECT_CLOUD_SAVE_ENV = 'OCTOPUS_DETECT_SKIP_CLOUD_SAVE';

export async function persistGeneratedTask(options: {
  task: CloudSavableTask;
  file: string;
  args: string[];
  saveToCloud?: boolean;
}): Promise<void> {
  await writeFile(options.file, `${JSON.stringify(options.task, null, 2)}\n`, 'utf8');
  if (options.saveToCloud === false || process.env[SKIP_DETECT_CLOUD_SAVE_ENV] === '1') return;

  const auth = await resolveAuth();
  if (!auth.credential) {
    console.warn('[warn] 任务已保存到本地，但云端同步需要登录。请运行 "bazhuayu auth login"。');
    return;
  }

  try {
    await saveDetectedTaskToCloud({
      auth: auth.credential,
      baseUrl: valueAfter(options.args, '--api-base-url'),
      task: options.task
    });
  } catch (cloudError) {
    const msg = cloudError instanceof Error ? cloudError.message : String(cloudError);
    console.warn(`[warn] 云端保存失败（本地文件已写入）: ${msg}`);
  }
}
