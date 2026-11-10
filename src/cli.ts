import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { createDefaultDeps } from './deps.js';
import { killActiveChildren } from './exec.js';
import { pollOnce, runnerPaths } from './pipeline.js';
import { Ledger } from './state/ledger.js';
import { acquireLock } from './state/lock.js';

const USAGE = `Uso: tsx src/cli.ts <comando> [--config agent.config.json]

Comandos:
  poll         uma passada: processa solicitações aprovadas e novas (agende no cron)
  status       mostra o ledger
  retry <id>   libera uma solicitação finalizada para nova tentativa`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { config: { type: 'string', default: 'agent.config.json' }, help: { type: 'boolean', short: 'h' } },
  });
  const [command, id] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  const config = await loadConfig(values.config);
  const paths = runnerPaths(config.workDir);

  switch (command) {
    case 'poll': {
      const report = await pollOnce(await createDefaultDeps(config));
      if (report.locked) return 0;
      const counts = report.processed.reduce<Record<string, number>>((acc, run) => {
        acc[run.outcome] = (acc[run.outcome] ?? 0) + 1;
        return acc;
      }, {});
      console.log(
        JSON.stringify({
          processed: counts,
          alreadyHandled: report.alreadyHandled.length,
          pending: report.pending.length,
          invalid: report.invalid.length,
          recovered: report.recovered,
        }),
      );
      return 0;
    }

    case 'status': {
      const entries = (await Ledger.open(paths.ledger)).list();
      if (entries.length === 0) console.log('ledger vazio');
      for (const entry of entries) {
        const cost = entry.costUsd !== undefined ? ` US$ ${entry.costUsd.toFixed(2)}` : '';
        console.log(`${entry.id.padEnd(16)} ${entry.status.padEnd(10)} ${entry.branch ?? ''}${cost}`);
        for (const reason of entry.reasons) console.log(`${' '.repeat(17)}• ${reason}`);
      }
      return 0;
    }

    case 'retry': {
      if (!id) throw new Error('informe o id: retry <id>');
      const lock = await acquireLock(paths.lock);
      if (!lock) throw new Error('um poll está rodando; tente de novo em instantes');
      try {
        await (await Ledger.open(paths.ledger)).remove(id);
      } finally {
        await lock.release();
      }
      console.log(`${id} liberada: será processada no próximo poll`);
      return 0;
    }

    default:
      console.error(USAGE);
      return 1;
  }
}

// Children run in their own process groups, so they would survive the orchestrator.
// Stop them too; the interrupted run is turned into "failed" by the next poll.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const stopped = killActiveChildren('SIGTERM');
    console.error(`${signal} received; stopped ${stopped} child process(es)`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  },
);
