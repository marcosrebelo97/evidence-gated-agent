# evidence-gated-agent

Transforma uma solicitação **aprovada por um humano**, escrita em linguagem
natural e com prints de tela, numa **branch pronta para revisão**, implementada
por um agente de IA headless (Claude Code) num git worktree isolado.

A IA escreve o código, mas **não decide nada sobre publicá-lo**. O push é
decidido por um orquestrador determinístico, que cruza o que o agente declarou
com evidência objetiva: commit real no git, escopo respeitado e testes
reexecutados por conta própria. O merge continua humano.

> Este repositório é uma versão genérica e aberta de um padrão que aplico em
> projetos privados. Não contém código, dados nem regras de negócio de nenhum
> deles.

## Por que existe

Fazer um agente escrever código é a parte fácil. A parte difícil é o sistema
em volta dele, para que o código seja confiável o bastante para chegar a
produção. Este projeto organiza esse sistema em torno de três ideias:

- **O determinístico fica no código; o raciocínio fica no LLM.** Detecção,
  git, gates, push e notificação não passam por um modelo. O agente só recebe
  a parte que exige raciocínio: entender o pedido e implementar.
- **Humano nas duas pontas.** Nada roda sem aprovação explícita, e nada vai
  para a branch principal sem revisão e merge humanos. A autonomia vive só no
  meio.
- **Saber não agir é um resultado.** Uma solicitação ambígua vira perguntas
  objetivas ao solicitante (`blocked`), não código chutado.

## Como funciona

```mermaid
flowchart TD
    A["Solicitação em linguagem natural<br/>+ prints de tela"] --> B{"Aprovação humana"}
    B -- aprovada --> C["Poll agendado<br/>lock de instância única + ledger"]
    C --> D["Worktree isolado<br/>branch agent/&lt;id&gt;-&lt;slug&gt;"]
    D --> E["Claude Code headless<br/>roteiro de 10 etapas"]
    E -- "STATUS + REPORT.md" --> F{"Orquestrador confere a evidência"}
    F -- blocked --> G["Perguntas ao solicitante"]
    F -- "commit + escopo + gates verdes" --> H["Push da branch do agente"]
    F -- "evidência não confirma" --> I["Rejeitado<br/>worktree preservado"]
    G --> J["Notificação (console ou Telegram)"]
    H --> J
    I --> J
    J --> K["Revisão e merge humanos"]
```

1. **Entrada** — cada solicitação é um JSON com título, descrição, solicitante,
   anexos e a aprovação (`approvedBy`, `approvedAt`). Sem aprovação, ela é
   ignorada. A fonte padrão é uma pasta (`FileRequestSource`); trocar por uma
   API é implementar `RequestSource`.
2. **Detecção idempotente** — o `poll` (agendado no cron) pega um lock de
   instância única e consulta o ledger: cada solicitação roda uma única vez.
3. **Isolamento** — um worktree descartável por solicitação, criado a partir da
   branch base remota. O clone principal nunca muda de branch.
4. **Agente com roteiro** — o prompt não é "implemente isso": é o
   [roteiro de 10 etapas](playbook/agent-playbook.md), com critério explícito de
   ambiguidade, testes, type-check, code-review do próprio diff, commit
   cirúrgico e um contrato de saída legível por máquina.
5. **Publicação por evidência** — o orquestrador confere o git e reexecuta os
   gates. Só então decide.
6. **Desfecho** — relatório do agente e motivos da decisão vão para o
   responsável; a revisão e o merge são humanos.

## A decisão de publicar

A decisão é uma função pura ([`decide`](src/gates.ts)). A autodeclaração do
agente é só a precondição; todo o resto é conferido:

| Condição | Por que existe |
| --- | --- |
| Agente declarou `implemented` | Precondição — nunca suficiente sozinha |
| Existe commit novo na branch | Pega o "fiz tudo" sem nada feito |
| Worktree limpo | Se sobrou algo sem commit, os gates não testaram o que vai ser publicado |
| Nenhum caminho proibido no diff | `.env`, chaves e segredos ficam fora do alcance |
| Todos os gates verdes, **reexecutados pelo orquestrador** | Não confia no "a suíte passou" do agente |
| Pelo menos um gate configurado | Sem evidência, não há publicação — a config sem gates é recusada |

### Desfechos

| Desfecho | Significado | Worktree |
| --- | --- | --- |
| `published` | Evidência confirmada, branch enviada | removido |
| `ready` | Evidência confirmada, push desativado na config | mantido |
| `blocked` | Solicitação ambígua; o relatório traz as perguntas | removido |
| `rejected` | O agente declarou sucesso, mas a evidência não confirmou | mantido para inspeção |
| `failed` | Falha do agente (crash, timeout, contrato violado) ou da infraestrutura | mantido para inspeção |

## Guardrails

- **Humano nas pontas**: aprovação explícita na entrada; o orquestrador nunca
  faz merge, nunca usa `--force` e se recusa a fazer push na branch base.
- **Ferramentas do agente restritas**: a configuração de exemplo libera só
  leitura, edição, testes, type-check e git local, e proíbe `git push` e acesso
  à web. O agente só pode escrever fora do worktree na pasta do run
  (`--add-dir`).
- **Solicitação é dado, não instrução**: o texto vai delimitado no prompt, os
  placeholders são preenchidos numa única passada e tags de fechamento dentro
  do texto são neutralizadas.
- **Sem shell**: todo processo externo é criado com `spawn` e `shell: false`; o
  timeout derruba o grupo de processos inteiro.
- **Idempotência e recuperação**: o ledger registra `running` antes de qualquer
  trabalho, com escrita atômica. Se o processo morrer no meio, o próximo poll
  marca aquele run como `failed` — nunca fica pendurado, nunca é retentado em
  silêncio.
- **Identidade do agente**: os commits do agente saem com um autor próprio
  (`agent.gitAuthor`), separando o trabalho dele do humano no histórico.

## Auditoria

Cada tentativa guarda tudo o que é preciso para reconstruir a decisão:

```
.agent-runner/
├── ledger.json                      # uma entrada por solicitação
└── runs/REQ-101/2026-01-15T13-40-00-000Z/
    ├── request.json                 # a solicitação como chegou
    ├── attachments/                 # cópias dos anexos que o agente viu
    ├── setup.json                   # resultado do setup (ex.: npm ci)
    ├── prompt.md                    # o prompt exato
    ├── agent-output.json            # saída da sessão headless (custo, turnos)
    ├── STATUS / REPORT.md           # contrato escrito pelo agente
    ├── evidence.json                # commits, arquivos, gates e a decisão
    └── summary.json                 # o que foi notificado
```

Um `retry` cria uma nova pasta de tentativa; a anterior é preservada.

## Uso

Requisitos: Node.js 20+, git e o [Claude Code](https://claude.com/claude-code)
instalado e autenticado na máquina que roda o poll.

```bash
npm install
cp agent.config.example.json agent.config.json   # ajuste repoPath, inboxDir e gates
npm run poll                                      # uma passada
npm run status                                    # estado do ledger
npm run retry -- REQ-102                          # libera para nova tentativa
```

Agendamento (a cada 15 minutos; o lock impede passadas sobrepostas):

```cron
*/15 * * * * cd /opt/evidence-gated-agent && npm run poll >> poll.log 2>&1
```

Para notificar no Telegram, use `"notifier": { "type": "telegram", "chatId": "<id>" }`
e defina `TELEGRAM_BOT_TOKEN` no ambiente — o token nunca vai no arquivo de
configuração.

Em [`examples/inbox`](examples/inbox) há três solicitações: uma clara e
aprovada, com print (REQ-101); uma aprovada mas ambígua, que deve terminar em
`blocked` (REQ-102); e uma sem aprovação, que é ignorada (REQ-103).

## Testes

```bash
npm run check   # typecheck + 103 testes
```

- **Unitários** para cada peça: a função `decide` em todas as combinações, o
  contrato do runner (crash, timeout, status inválido, arquivos de tentativa
  anterior), o prompt (injeção de delimitadores e placeholders), ledger, lock,
  escopo.
- **Pipeline** com fakes para todos os desfechos, idempotência, lock,
  recuperação de crash e anexos fora da pasta.
- **Ponta a ponta com git real**: remote bare, worktrees e pushes reais, e um
  [agente falso](test/fixtures/fake-agent.mjs) que se comporta como o
  `claude -p` — lê o prompt do stdin, commita e escreve o contrato. Prova cada
  desfecho sem gastar crédito de API, inclusive pelo CLI.

## Estrutura

```
src/
├── cli.ts          # poll · status · retry
├── pipeline.ts     # orquestra um poll e um run
├── gates.ts        # gates reexecutados + decide()
├── agent/          # prompt a partir do roteiro + runner headless
├── git.ts          # worktree, evidência no git, push
├── scope.ts        # caminhos proibidos, nome de branch
├── state/          # ledger e lock
├── source.ts       # fonte de solicitações (pasta)
├── notify.ts       # console e Telegram
├── exec.ts         # único ponto que cria processos
└── config.ts · request.ts · deps.ts
playbook/agent-playbook.md   # o roteiro que o agente segue
```

## Limitações conhecidas e próximos passos

- Uma solicitação por vez. Paralelizar exige uma fila e um limite de worktrees
  simultâneos — o ledger e o lock já isolam o estado para isso.
- O desfecho é um push de branch; abrir o PR automaticamente, com o relatório
  como descrição, é o próximo passo natural.
- Métricas que valem acompanhar: taxa de `published` aceito sem retrabalho na
  revisão, lead time da aprovação até a branch, apontamentos da revisão humana
  por entrega e taxa de `blocked` legítimo.
- Realimentar o roteiro com os apontamentos da revisão humana.

As decisões de projeto, inclusive o que ficou de fora de propósito, estão em
[DECISIONS.md](DECISIONS.md).

## Trabalhando neste repositório com IA

O [`CLAUDE.md`](CLAUDE.md) descreve os invariantes que não podem regredir, e
[`.claude/agents/guardiao-invariantes.md`](.claude/agents/guardiao-invariantes.md)
é um agente revisor que confere um diff contra eles antes do commit. Os dois
são versionados de propósito: fazem parte de como o projeto é mantido.

## Licença

[MIT](LICENSE)
