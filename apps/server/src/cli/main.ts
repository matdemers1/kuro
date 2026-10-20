import { seedDev } from './seedDev.js';
import { spike } from './spike.js';

/** `kuro <command>` — operator commands, run inside the server image or with tsx. */
const commands: Record<string, () => Promise<number>> = { spike: () => spike(), 'seed-dev': () => seedDev() };

const name = process.argv[2] ?? '';
const command = commands[name];
if (command === undefined) {
  console.error(`usage: kuro <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}
process.exit(await command());
