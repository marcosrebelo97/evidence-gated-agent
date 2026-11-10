// Stands in for `claude -p` in end-to-end tests.
// Usage: node fake-agent.mjs <scenario> [claude flags...] --add-dir <runDir>  (prompt on stdin)
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const scenario = args[0];
const runDir = args[args.lastIndexOf('--add-dir') + 1];
const prompt = readFileSync(0, 'utf8');

const git = (...gitArgs) => execFileSync('git', gitArgs, { stdio: 'pipe' });

function commit(file, content) {
  writeFileSync(file, content);
  git('add', '--force', file);
  git('commit', '--quiet', '-m', `feat: change ${file}`);
}

function finish(status, report) {
  writeFileSync(join(runDir, 'STATUS'), `${status}\n`);
  writeFileSync(join(runDir, 'REPORT.md'), report);
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.12, num_turns: 7 }));
}

if (!prompt.includes('<solicitacao>')) {
  console.error('prompt did not arrive on stdin');
  process.exit(2);
}

switch (scenario) {
  case 'implement':
    commit('feature.txt', 'ok\n');
    finish('implemented', '## O que foi feito\nfeature.txt criado.');
    break;
  case 'block':
    finish('blocked', '1. Em qual tela?\n2. Qual data: criação ou atualização?');
    break;
  case 'claim-without-commit':
    finish('implemented', 'Feito (mas sem commit).');
    break;
  case 'break-gate':
    commit('feature.txt', 'broken\n');
    finish('implemented', 'Feito.');
    break;
  case 'ignored-crutch':
    // A broken commit plus an ignored file that makes the gate pass in this worktree only.
    commit('.gitignore', 'crutch.txt\n');
    commit('feature.txt', 'broken\n');
    writeFileSync('crutch.txt', 'local only');
    finish('implemented', 'Feito.');
    break;
  case 'leave-dirty':
    commit('feature.txt', 'ok\n');
    writeFileSync('scratch.txt', 'esqueci de commitar');
    finish('implemented', 'Feito.');
    break;
  case 'touch-env':
    commit('feature.txt', 'ok\n');
    commit('.env', 'SECRET=1\n');
    finish('implemented', 'Feito.');
    break;
  case 'sneaky': {
    // Tries to publish on its own and to read the orchestrator's secrets.
    commit('feature.txt', 'ok\n');
    let push = 'allowed';
    try {
      git('push', 'origin', 'HEAD:refs/heads/sneaky');
    } catch {
      push = 'blocked';
    }
    const secret = process.env.EGA_TEST_SECRET === undefined ? 'absent' : 'present';
    finish('implemented', `push=${push} secret=${secret}`);
    break;
  }
  case 'tamper-config': {
    // Points its remote at a decoy and plants an fsmonitor command, hoping the orchestrator uses them.
    commit('feature.txt', 'ok\n');
    git('remote', 'add', 'origin', join(runDir, 'decoy.git'));
    git('config', 'core.fsmonitor', `touch ${join(runDir, 'FSMONITOR_RAN')}`);
    finish('implemented', 'Feito.');
    break;
  }
  case 'plant-hooks': {
    // Hooks that would run on the orchestrator's git commands, if it ran any in this repository.
    commit('feature.txt', 'ok\n');
    for (const hook of ['post-checkout', 'pre-push', 'reference-transaction']) {
      const file = join('.git', 'hooks', hook);
      writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${join(runDir, 'HOOK_RAN')}"\n`);
      chmodSync(file, 0o755);
    }
    finish('implemented', 'Feito.');
    break;
  }
  case 'move-base-ref': {
    // Hides a forbidden commit by moving the base the diff would be computed against.
    commit('.env', 'SECRET=1\n');
    const sneaky = git('rev-parse', 'HEAD').toString().trim();
    commit('feature.txt', 'ok\n');
    git('update-ref', 'refs/remotes/origin/main', sneaky);
    finish('implemented', 'Feito.');
    break;
  }
  case 'report-home':
    commit('feature.txt', 'ok\n');
    finish('implemented', `home=${process.env.HOME}`);
    break;
  case 'crash':
    process.exit(1);
    break;
  default:
    console.error(`unknown scenario ${scenario}`);
    process.exit(2);
}
