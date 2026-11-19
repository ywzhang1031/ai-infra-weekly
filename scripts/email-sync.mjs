import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emailDraftDirectory, parseEmailOptions, prepareEmailDraft } from './email-draft.mjs';
import { syncButtondownDraft } from './buttondown-api.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function prepareAndSyncEmailDraft(options) {
  const prepared = prepareEmailDraft(options);
  rmSync(join(dirname(prepared.manifestPath), 'generation-error.json'), { force: true });
  return syncButtondownDraft({ root: options.root ?? root, expectedWeek: options.expectedWeek, emailTestId: options.emailTestId });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let options;
  try {
    options = parseEmailOptions(args);
    const result = prepareAndSyncEmailDraft({ root, ...options });
    console.log(JSON.stringify({ ...result, sendsEmail: false }, null, 2));
  } catch (error) {
    if (options) {
      const directory = emailDraftDirectory({ root, ...options });
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'sync-pending.json'), JSON.stringify({ status: 'pending', ...(options.emailTestId === undefined ? {} : { testId: options.emailTestId }), attemptedAt: new Date().toISOString(), message: error.message }, null, 2) + '\n');
    }
    console.error(`Email draft pending: ${error.message}`);
    process.exitCode = 1;
  }
}
