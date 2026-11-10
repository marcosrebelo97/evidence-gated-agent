# Contexto do projeto

Orquestrador que transforma uma solicitação **aprovada por um humano** em uma
branch pronta para revisão, implementada por um agente de IA headless (Claude
Code) num repositório próprio e isolado. O orquestrador é determinístico; a IA fica só
no miolo. **Quem decide o push é o orquestrador, cruzando a autodeclaração do
agente com evidência objetiva — nunca a IA.**

## Invariantes (não podem regredir — qualquer mudança aqui exige teste)

1. **Humano nas pontas**: só solicitações com aprovação explícita entram; o
   orquestrador nunca faz merge, só push de branch própria (sem `--force`).
2. **Publicação por evidência**: push exige status `implemented` + commit novo
   no git + working tree limpo + nenhum caminho proibido tocado (renames
   inclusos) + todos os gates verdes num repositório novo, no commit exato. O push
   envia esse SHA, do clone principal. A decisão é uma função pura (`decide`)
   e deve continuar assim.
3. **`blocked` é resultado de primeira classe**: solicitação ambígua vira
   perguntas ao solicitante, nunca código chutado.
4. **Idempotência**: ledger + lock de instância única — cada solicitação roda
   uma vez, uma instância por vez. Run interrompido vira `failed`, nunca fica
   `running` para sempre.
5. **Isolamento e auditoria**: um repositório e um `HOME` descartáveis por solicitação; cada
   tentativa preserva solicitação, anexos, prompt, saída e stderr do agente,
   evidências e relatório em `<workDir>/runs/<id>/<tentativa>/`. O agente só
   recebe `contract/` (escrita) e `attachments/` (leitura); o contrato é lido
   sem seguir symlink e a auditoria é sempre criada do zero.
6. **Sem shell**: todo processo externo é chamado com `spawn` e `shell: false`
   — texto de solicitação nunca vira comando.
7. **Sandbox**: agente e gates rodam com `inheritEnv: false` e o ambiente de
   `sandboxEnv` (allowlist + git sem transporte). Só o orquestrador publica.
8. **`workDir` fora do alvo e do orquestrador**: senão o agente herda o
   `CLAUDE.md` errado.
9. **Nada compartilhado com o agente**: ele trabalha num repositório próprio
   (nunca um worktree) e num `HOME` vazio. Agente, gates e todo git dentro do
   repositório dele passam por `Isolation` (`src/isolation.ts`), declarando
   mounts e rede; o git roda sem rede, com um `HOME` descartável e
   `GIT_CONFIG_GLOBAL=/dev/null`. O commit chega ao clone principal só como
   bundle, com `transfer.fsckObjects`.
   Evidência, verificação e push saem da `Baseline` (SHA da base e push URLs,
   anotados no `fetch`) e do SHA coletado; o push é recusado se os URLs
   mudaram. Só o setup sobre a base intacta usa o `HOME` do usuário.
10. **Modo container**: com `isolation.mode = "container"`, o código não
    confiável só enxerga os mounts declarados. `containerArgs` mantém
    `--cap-drop ALL`, `no-new-privileges`, `--read-only`, `--pull never`,
    usuário não root, segredos por referência e nunca a rede `host`; o
    container é removido depois de todo comando.

## Stack

Node.js 20+ · TypeScript strict (`noUncheckedIndexedAccess`) · Zod na borda ·
Vitest · tsx. Sem framework de agentes: o agente já é o Claude Code.

## Arquitetura

- `src/exec.ts` — único ponto que cria processos (timeout, process group, captura limitada)
- `src/sandbox.ts` — ambiente do agente e dos gates (allowlist, git sem transporte)
- `src/config.ts` / `src/request.ts` — schemas Zod da configuração e da solicitação
- `src/state/` — ledger (escrita atômica) e lock
- `src/git.ts` / `src/scope.ts` — repositório do agente, coleta do SHA, evidência, caminhos proibidos
- `src/agent/` — montagem do prompt a partir do roteiro e execução headless
- `src/gates.ts` — gates e a função `decide`; a verificação no commit exato fica em `pipeline.ts`
- `src/notify.ts` — console e Telegram
- `src/pipeline.ts` — orquestra um poll; `src/cli.ts` — entrada
- `playbook/agent-playbook.md` — o roteiro de 10 etapas que o agente segue

Dependências entram por injeção (`PipelineDeps`), para que o pipeline seja
testável com fakes e o e2e rode com git real e um agente falso.

## Comandos

```bash
npm run check        # typecheck + testes (rodar antes de todo commit)
npm test             # vitest (hermético, sem Docker)
npm run test:container  # modo container com Docker real (opt-in)
npm run poll         # uma passada do orquestrador (agendar no cron)
npm run status       # estado do ledger
npm run retry <id>   # libera uma solicitação para nova tentativa
```

## Convenções

- Commits pequenos, conventional commits em inglês.
- Mensagens para humanos (relatório, notificação) em pt-BR; código em inglês.
- Erro de infraestrutura nunca derruba o poll inteiro: vira `failed` daquela
  solicitação, com o motivo registrado no ledger.
- Antes de mexer em `decide`, `pipeline` ou no roteiro, rode o agente
  `.claude/agents/guardiao-invariantes.md` sobre o diff.
