import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** Read one line from the terminal; with `hidden`, nothing typed is echoed. */
export function prompt(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _enc, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (opts.hidden === true) process.stdout.write('\n');
      resolve(answer.trim());
    });
    muted = opts.hidden === true;
  });
}
