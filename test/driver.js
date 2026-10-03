import { run } from '../src/cli.js';
import { writeFile } from 'node:fs/promises';
import { confirm } from '../src/io.js';
import { openBrowser } from '../src/browser.js';

const options = JSON.parse(process.env.OIL_TEST_RUNTIME || '{}');
let time = options.startTime ?? 0;
const trace = { delays: [], questions: [], browserUrls: [], browserTimeouts: [] };
const answers = [...(options.answers || [])];
const questioner = async (question) => {
  trace.questions.push(question);
  const answer = answers.shift();
  return answer === true ? 'yes' : answer === false ? 'no' : String(answer ?? '');
};
process.exitCode = await run(process.argv.slice(2), {
  terminal: options.terminal ?? options.interactive ?? false,
  interactive: options.interactive ?? false,
  now: () => time,
  openBrowser: async (url, timeoutMs) => {
    trace.browserUrls.push(url);
    trace.browserTimeouts.push(timeoutMs);
    if (options.browserDelay === undefined) return await openBrowser(url, undefined, undefined, timeoutMs);
    time += Math.min(options.browserDelay, timeoutMs);
    return false;
  },
  sleep: async (ms, unused, { signal }) => { if (signal.aborted) throw new Error('aborted'); trace.delays.push(ms); time += ms; },
  confirm: (question, yes, interactive, signal, defaultYes) => confirm(question, yes, interactive, signal, defaultYes, questioner),
  ask: questioner,
});
await writeFile(process.env.OIL_TEST_TRACE, JSON.stringify(trace));
