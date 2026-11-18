import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareEmailDraft } from './email-draft.mjs';
import { syncButtondownDraft } from './buttondown-api.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function prepareAndSyncEmailDraft(options) {
  const prepared = prepareEmailDraft(options);
  rmSync(join(dirname(prepared.manifestPath), 'generation-error.json'), { force: true });
  return syncButtondownDraft({ root: options.root ?? root, expectedWeek: options.expectedWeek });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 2 || args[0] !== '--expected-week' || !/^\d{4}-\d{2}-\d{2}$/.test(args[1])) {
      throw new Error('Usage: node scripts/email-sync.mjs --expected-week YYYY-MM-DD');
    }
    const result = prepareAndSyncEmailDraft({ root, expectedWeek: args[1] });
    console.log(JSON.stringify({ ...result, sendsEmail: false }, null, 2));
  } catch (error) {
    if (args.length === 2 && args[0] === '--expected-week' && /^\d{4}-\d{2}-\d{2}$/.test(args[1])) {
      const directory = join(root, '.local-maintenance', 'newsletters', args[1]);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'sync-pending.json'), JSON.stringify({ status: 'pending', attemptedAt: new Date().toISOString(), message: error.message }, null, 2) + '\n');
    }
    console.error(`Email draft pending: ${error.message}`);
    process.exitCode = 1;
  }
}
