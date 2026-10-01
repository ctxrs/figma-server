import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { productionModule } from './runtime.mjs';

const { State, Metadata } = await productionModule('state');
const { runCli } = await productionModule('cli');
const { Core } = await productionModule('core');
const { serve } = await productionModule('main');
const { Fault } = await productionModule('errors');
const state = new State(process.env.QUALIFY_LOGIN_ROOT);
const mode = process.env.QUALIFY_LOGIN_MODE;
let stopped = false, expired = false, accountState = 'needs_login', daemon, core;
const backend = {
  status: () => ({ account: 'default', state: accountState }),
  async login(_account, confirmation) {
    accountState = 'authorizing';
    if (mode === 'offline') return confirmation();
    let timer;
    try {
      await Promise.race([confirmation(), new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Fault('login_timeout', 'Independent backend deadline expired.', 409)); }, 40);
      })]);
    } finally { clearTimeout(timer); accountState = 'needs_login'; }
  },
  async stop() { stopped = true; accountState = 'stopped'; },
};
if (mode === 'daemon') {
  core = new Core(backend, state, await Metadata.open(state));
  daemon = await serve(core, { token: await state.secret(), accounts: ['default'] });
}
// Inject only the TTY gate and deadline. Readline owns the real, open stdin pipe.
process.stdin.isTTY = true;
try {
  process.exitCode = await runCli(['login'], { state, browser: () => backend, confirmationMs: 150 });
} finally { await daemon?.close(); await core?.stop(); }
await writeFile(join(process.env.QUALIFY_LOGIN_EVIDENCE, mode + '.json'), JSON.stringify({
  mode, code: process.exitCode, paused: process.stdin.isPaused(), dataListeners: process.stdin.listenerCount('data'),
  stopped, expired, accountState,
}, null, 2) + '\n');
// No process.exit(), stdin EOF or injected pause: the process must exit naturally.
