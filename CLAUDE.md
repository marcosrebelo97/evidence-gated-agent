# Contexto do projeto

Orquestrador que transforma uma solicitação **aprovada por um humano** em uma
branch pronta para revisão, implementada por um agente de IA headless (Claude
Code) num git worktree isolado. O orquestrador é determinístico; a IA fica só
no miolo. **Quem decide o push é o orquestrador, cruzando a autodeclaração do
agente com evidência objetiva — nunca a IA.**

## Invariantes (não podem regredir — qualquer mudança aqui exige teste)

1. **Humano nas pontas**: só solicitações com aprovação explícita entram; o
   orquestrador nunca faz merge, só push de branch própria (sem `--force`).
2. **Publicação por evidência**: push exige status `implemented` + commit novo
   no git + working tree limpo + nenhum caminho proibido tocado (renames
   inclusos) + todos os gates verdes num worktree novo, no commit exato. O push
   envia esse SHA, do clone principal. A decisão é uma função pura (`decide`)
   e deve continuar assim.
3. **`blocked` é resultado de primeira classe**: solicitação ambígua vira
   perguntas ao solicitante, nunca código chutado.
4. **Idempotência**: ledger + lock de instância única — cada solicitação roda
   uma vez, uma instância por vez. Run interrompido vira `failed`, nunca fica
   `running` para sempre.
5. **Isolamento e auditoria**: um worktree descartável por solicitação; cada
   tentativa preserva solicitação, anexos, prompt, saída e stderr do agente,
   evidências e relatório em `<workDir>/runs/<id>/<tentativa>/`.
6. **Sem shell**: todo processo externo é chamado com `spawn` e `shell: false`
   — texto de solicitação nunca vira comando.
7. **Sandbox**: agente e gates rodam com `inheritEnv: false` e o ambiente de
   `sandboxEnv` (allowlist + git sem transporte). Só o orquestrador publica.
8. **`workDir` fora do alvo e do orquestrador**: senão o agente herda o
   `CLAUDE.md` errado.

## Stack

Node.js 20+ · TypeScript strict (`noUncheckedIndexedAccess`) · Zod na borda ·
Vitest · tsx. Sem framework de agentes: o agente já é o Claude Code.

## Arquitetura

- `src/exec.ts` — único ponto que cria processos (timeout, process group, captura limitada)
- `src/sandbox.ts` — ambiente do agente e dos gates (allowlist, git sem transporte)
- `src/config.ts` / `src/request.ts` — schemas Zod da configuração e da solicitação
- `src/state/` — ledger (escrita atômica) e lock
- `src/git.ts` / `src/scope.ts` — worktree, evidência no git, caminhos proibidos
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
npm test             # vitest
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
