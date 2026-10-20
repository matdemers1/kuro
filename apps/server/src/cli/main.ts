import { catalogImport } from './catalogImport.js';
import { fillerRefresh } from './fillerRefresh.js';
import { importJson } from './importJson.js';
import { loadFixture } from './loadFixture.js';
import { matcherEval } from './matcherEval.js';
import { rotateKey } from './rotateKey.js';
import { seedDev } from './seedDev.js';
import { spike } from './spike.js';
import { vapidKeys } from './vapidKeys.js';

/** `kuro <command>` — operator commands, run inside the server image or with tsx. */
const commands: Record<string, () => Promise<number>> = { spike: () => spike(), 'catalog-import': () => catalogImport(process.argv.slice(3)), 'filler-refresh': () => fillerRefresh(), 'import-json': () => importJson(process.argv.slice(3)), 'matcher-eval': () => matcherEval(process.argv.slice(3)), 'load-fixture': () => loadFixture(process.argv.slice(3)), 'seed-dev': () => seedDev(), 'rotate-key': () => rotateKey(), 'vapid-keys': () => Promise.resolve(vapidKeys()) };

const name = process.argv[2] ?? '';
const command = commands[name];
if (command === undefined) {
  console.error(`usage: kuro <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}
process.exit(await command());
