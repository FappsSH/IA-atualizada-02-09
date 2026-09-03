import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npxCommand, ['supabase', ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env },
});
process.exit(result.status ?? 1);
