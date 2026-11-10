// Stands in for `claude -p` in end-to-end tests.
// Usage: node fake-agent.mjs <scenario> [claude flags...] --add-dir <contractDir> [--add-dir <dir>...]  (prompt on stdin)
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const scenario = args[0];
const contractDir = args[args.indexOf('--add-dir') + 1];
/** Paths given right after the scenario, before the claude flags. */
const targets = [];
for (const arg of args.slice(1)) {
  if (arg.startsWith('-')) break;
  targets.push(arg);
}
const prompt = readFileSync(0, 'utf8');

const git = (...gitArgs) => execFileSync('git', gitArgs, { stdio: 'pipe' });

function commit(file, content) {
  writeFileSync(file, content);
  git('add', '--force', file);
  git('commit', '--quiet', '-m', `feat: change ${file}`);
}

function finish(status, report) {
  writeFileSync(join(contractDir, 'STATUS'), `${status}\n`);
  writeFileSync(join(contractDir, 'REPORT.md'), report);
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
    git('remote', 'add', 'origin', join(contractDir, 'decoy.git'));
    git('config', 'core.fsmonitor', `touch ${join(contractDir, 'FSMONITOR_RAN')}`);
    finish('implemented', 'Feito.');
    break;
  }
  case 'plant-hooks': {
    // Hooks that would run on the orchestrator's git commands, if it ran any in this repository.
    commit('feature.txt', 'ok\n');
    for (const hook of ['post-checkout', 'pre-push', 'reference-transaction']) {
      mkdirSync(join('.git', 'hooks'), { recursive: true });
      const file = join('.git', 'hooks', hook);
      writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${join(contractDir, 'HOOK_RAN')}"\n`);
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
    finish('implemented', `home=${process.env.HOME}\ntmpdir=${tmpdir()}`);
    break;
  case 'crash':
    process.exit(1);
    break;
  case 'escape': {
    // Tries to write each target from wherever it runs; reports what happened to each.
    const results = targets.map((target) => {
      try {
        appendFileSync(target, 'pwned\n');
        return `${target}: written`;
      } catch (error) {
        return `${target}: ${error.code}`;
      }
    });
    commit('feature.txt', 'ok\n');
    finish('implemented', results.join('\n'));
    break;
  }
  case 'symlink-report':
    commit('feature.txt', 'ok\n');
    writeFileSync(join(contractDir, 'STATUS'), 'implemented\n');
    symlinkSync(targets[0], join(contractDir, 'REPORT.md'));
    process.stdout.write(JSON.stringify({ type: 'result', is_error: false }));
    break;
  case 'hang':
    setInterval(() => undefined, 1_000);
    break;
  default:
    console.error(`unknown scenario ${scenario}`);
    process.exit(2);
}
