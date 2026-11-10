// Stands in for `claude -p` in end-to-end tests.
// Usage: node fake-agent.mjs <scenario> [claude flags...] --add-dir <runDir>  (prompt on stdin)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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
  case 'crash':
    process.exit(1);
    break;
  default:
    console.error(`unknown scenario ${scenario}`);
    process.exit(2);
}
