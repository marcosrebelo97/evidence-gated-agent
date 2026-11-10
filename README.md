# evidence-gated-agent

Transforma uma solicitação **aprovada por um humano**, escrita em linguagem
natural e com prints de tela, numa **branch pronta para revisão**, implementada
por um agente de IA headless (Claude Code) num repositório isolado.

A IA escreve o código, mas **não decide nada sobre publicá-lo**. O push é
decidido por um orquestrador determinístico, que cruza o que o agente declarou
com evidência objetiva: commit real no git, escopo respeitado e testes
reexecutados por conta própria, num checkout limpo do commit exato. O merge
continua humano.

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
    C --> D["Repositório próprio do agente<br/>branch agent/&lt;id&gt;-&lt;slug&gt; · HOME vazio"]
    D --> E["Claude Code headless, em sandbox<br/>roteiro de 10 etapas"]
    E -- "STATUS + REPORT.md" --> F{"SHA coletado para o clone principal<br/>commit · sem sobras · escopo"}
    F -- blocked --> G["Perguntas ao solicitante"]
    F -- "não confirma" --> I["Rejeitado<br/>repositório preservado"]
    F -- confirma --> V["Repositório novo só com o SHA<br/>setup + gates"]
    V -- "algum gate vermelho" --> I
    V -- "todos verdes" --> H["Push do SHA verificado"]
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
3. **Isolamento** — cada solicitação ganha um repositório próprio e descartável
   (não um worktree), com só o commit base, e um `HOME` vazio. O agente não
   compartilha hooks, config, refs nem dotfiles com o orquestrador, e o
   orquestrador nunca roda git com o próprio ambiente dentro dele.
4. **Agente com roteiro** — o prompt não é "implemente isso": é o
   [roteiro de 10 etapas](playbook/agent-playbook.md), com critério explícito de
   ambiguidade, testes, type-check, code-review do próprio diff, commit
   cirúrgico e um contrato de saída legível por máquina.
5. **Publicação por evidência** — o orquestrador traz o `HEAD` do agente para o
   clone principal, compara com o SHA da base anotado antes do agente rodar,
   cria outro repositório novo só com esse commit, roda o setup e os gates ali
   e, só se tudo estiver verde, faz push **daquele SHA**.
6. **Desfecho** — relatório do agente e motivos da decisão vão para o
   responsável; a revisão e o merge são humanos.

## A decisão de publicar

A decisão é uma função pura ([`decide`](src/gates.ts)). A autodeclaração do
agente é só a precondição; todo o resto é conferido:

| Condição | Por que existe |
| --- | --- |
| Agente declarou `implemented` | Precondição — nunca suficiente sozinha |
| Existe commit novo sobre a base anotada | Pega o "fiz tudo" sem nada feito |
| Nada sem commit no repositório do agente | Se sobrou algo, o commit não é a entrega completa |
| Nenhum caminho proibido no diff contra a base anotada (renames inclusos) | `.env`, chaves e segredos ficam fora do alcance, mesmo renomeados ou escondidos movendo a ref da base |
| Gates verdes num **repositório novo, só com o commit exato** | Arquivos ignorados que o agente deixou, ou testes que mexem na branch, não influenciam o veredito |
| Pelo menos um gate configurado | Sem evidência, não há publicação — a config sem gates é recusada |

O push envia o SHA verificado, não "o que a branch tiver agora".

Arquivos que definem como os gates se comportam (`package.json`, lockfiles,
`*.config.*`, `tsconfig*.json`, `.husky/`) ou como os agentes trabalham
(`CLAUDE.md`, `.claude/`) podem ser alterados — muitas vezes legitimamente —, mas aparecem
destacados na notificação para o revisor (`attentionPaths`).

### Desfechos

| Desfecho | Significado | Repositório do agente |
| --- | --- | --- |
| `published` | Evidência confirmada, SHA enviado | removido |
| `ready` | Evidência confirmada, push desativado na config | mantido |
| `blocked` | Solicitação ambígua; o relatório traz as perguntas | removido |
| `rejected` | O agente declarou sucesso, mas a evidência não confirmou | mantido para inspeção |
| `failed` | Falha do agente (crash, timeout, contrato violado) ou da infraestrutura | mantido para inspeção |

## Guardrails

- **Humano nas pontas**: aprovação explícita na entrada; o orquestrador nunca
  faz merge, nunca usa `--force` e se recusa a fazer push na branch base.
- **Sandbox do agente e dos gates**: os dois rodam com um ambiente mínimo
  (`PATH`, locale, proxy e o que for liberado em `passEnv`) e um `HOME` vazio,
  novo a cada run — tokens, credenciais de nuvem, o agente SSH e os dotfiles do
  usuário (`~/.gitconfig`, `~/.npmrc`, `~/.ssh`) não chegam a eles. O Claude Code
  autentica por `ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN` liberados em
  `agent.passEnv`; sem nenhum dos dois, o poll recusa começar, em vez de
  falhar em toda solicitação. Os runs isolados compartilham só o cache do npm,
  para não baixar tudo de novo. O setup sobre a base intacta, antes do agente,
  é código confiável e mantém o `HOME` do usuário (chaves SSH, tokens de
  registry). O git lá dentro roda com `protocol.allow=never`, o que barra
  o `git push` do agente; um script escrito por ele pode desfazer essa variável,
  e contra isso vale o isolamento de sistema (abaixo).
- **Nada do repositório do agente executa do lado do orquestrador**: o agente
  trabalha num repositório próprio, não num worktree — hooks, config, refs e o
  ponteiro `.git` dele não são os do clone principal. O orquestrador traz o
  commit com `git fetch` (o `upload-pack` não executa a config nem os hooks do
  repositório servido) e, quando precisa rodar git lá dentro (`status`, o
  checkout da verificação), usa o ambiente do sandbox, um `HOME` descartável e
  nenhuma config global — um filtro plantado pelo agente roda sem privilégio e
  não alcança os dotfiles do usuário. Repositórios novos nascem sem os hooks de
  template do usuário. Os comandos git do orquestrador rodam sem hooks e sem
  fsmonitor.
- **Push só para onde o remote apontava**: o `fetch` anota os push URLs do
  remote (já com regras `insteadOf` aplicadas) antes do agente rodar. O push vai
  para esses URLs, com `--no-verify`, e é recusado se eles mudaram durante o
  run — um remote reescrito ou um `pushInsteadOf` plantado param a publicação
  em vez de desviá-la.
- **Ferramentas restritas**: por padrão o agente ignora configurações e
  servidores MCP do usuário (`--setting-sources project`,
  `--strict-mcp-config`); a configuração de exemplo libera só leitura, edição,
  testes, type-check e git local.
- **Solicitação é dado, não instrução**: o texto vai delimitado no prompt, os
  placeholders são preenchidos numa única passada e qualquer variação da tag
  delimitadora dentro do texto é neutralizada. Anexos são conferidos pelo
  caminho real (symlinks para fora da pasta são recusados).
- **Sem shell**: todo processo externo é criado com `spawn` e `shell: false`; o
  timeout derruba o grupo de processos inteiro, o que o agente ou os gates
  deixarem rodando em segundo plano morre quando eles terminam, e parar o
  orquestrador (Ctrl+C, systemd, SIGHUP) também para o agente.
- **Evidência presa a dois SHAs**: o da base, anotado no `fetch` antes do agente
  rodar, e o do agente, coletado uma vez para uma ref privada do clone
  principal. Commits, arquivos alterados, verificação e push saem desses dois
  — mover a branch ou a ref da base depois não muda o que é checado nem o que é
  publicado.
- **Idempotência e recuperação**: o ledger registra `running` antes de qualquer
  trabalho, com escrita atômica. Se o processo morrer no meio, o próximo poll
  marca aquele run como `failed` — nunca fica pendurado, nunca é retentado em
  silêncio.
- **Identidade do agente**: os commits do agente saem com um autor próprio
  (`agent.gitAuthor`), separando o trabalho dele do humano no histórico.

### O que o sandbox não cobre

O sandbox e o repositório próprio fecham os caminhos que o agente tem a partir
do lugar onde trabalha. Não substituem isolamento de sistema operacional: o
agente roda com o mesmo usuário do poll e um script dele ainda pode escrever,
por caminho absoluto, em qualquer arquivo desse usuário — inclusive no clone
principal. Em produção:

- rode o poll com um **usuário dedicado** (ou container), sem chaves além das
  necessárias;
- **proteja a branch base no servidor** (o orquestrador nunca a toca, mas a
  proteção não deve depender só dele);
- mantenha o **CI** como gate final do PR — o agente pode alterar a definição
  dos próprios testes, por isso essas mudanças são destacadas ao revisor.

A fronteira de confiança da entrada é quem pode escrever na fonte de
solicitações: a aprovação é um campo, e vale o controle de acesso da pasta (ou
da API) de onde ela vem.

## Validado com o Claude Code real

Além da suíte automatizada, o pipeline foi exercitado de ponta a ponta com o
Claude Code de verdade, num projeto Node de exemplo com um remote bare:

- **REQ-102** ("o relatório está errado, precisa mostrar a data certa"):
  `blocked` em 28 s, sem tocar em código, com sete perguntas objetivas ao
  solicitante.
- **REQ-101**, na primeira versão do texto: também `blocked` — e com razão. O
  pedido não dizia em qual fuso interpretar as datas, e um pedido feito às
  22h30 de Brasília cairia no dia seguinte em UTC. O agente mostrou o exemplo
  e perguntou.
- **REQ-101**, com o fuso e os casos-limite especificados (é a versão que está
  em `examples/inbox`): `published` em cerca de 2 minutos. O agente escreveu
  10 testes, um subagente revisou o diff e encontrou três pontos, corrigidos
  antes do commit. A branch publicada passou 12/12 testes num clone limpo.
  Custo da sessão: US$ 0,59.
- **REQ-101 de novo**, depois da troca do worktree por um repositório próprio
  do agente: `published` em 2 min 19 s, com 11 testes novos e 13/13 verdes na
  verificação. O commit chegou ao clone principal só por `git fetch`, o
  repositório do agente foi apagado e o clone principal ficou intocado. Custo:
  US$ 0,72.

## Auditoria

Cada tentativa guarda tudo o que é preciso para reconstruir a decisão:

```
~/.local/state/evidence-gated-agent/<repo>-<hash>/
├── ledger.json                      # uma entrada por solicitação (status, SHA, custo)
└── runs/REQ-101/2026-01-15T13-40-00-000Z/
    ├── request.json                 # a solicitação como chegou
    ├── attachments/                 # cópias dos anexos que o agente viu
    ├── setup.json                   # resultado do setup (ex.: npm ci)
    ├── prompt.md                    # o prompt exato
    ├── agent-output.json            # saída da sessão headless (custo, turnos)
    ├── agent-stderr.log             # diagnóstico quando o agente falha
    ├── STATUS / REPORT.md           # contrato escrito pelo agente
    ├── evidence.json                # SHA, arquivos, gates, atenção e a decisão
    └── summary.json                 # o que foi notificado
```

Os repositórios dos agentes ficam em `workspaces/<id>` (com o `HOME` ao lado,
em `<id>.home`). O commit coletado passa por `refs/evidence-gated-agent/<id>`
no clone principal só durante o run: a ref é apagada no fim, e o SHA fica no
ledger e no `evidence.json`. Um `retry` cria uma nova pasta de tentativa; a
anterior é preservada. O
`workDir` fica fora do repositório alvo e do orquestrador por padrão — o Claude
Code lê `CLAUDE.md` subindo pelas pastas, e o agente não pode herdar as
instruções erradas.

## Uso

Requisitos: Node.js 20+, git 2.29+ e o
[Claude Code](https://claude.com/claude-code) instalado na máquina que roda o
poll. Como o agente roda com um `HOME` vazio, a autenticação vem do ambiente:
`ANTHROPIC_API_KEY`, ou `CLAUDE_CODE_OAUTH_TOKEN` gerado com
`claude setup-token` para quem usa assinatura — os dois já estão em
`agent.passEnv` por padrão. Para usar o login guardado em `~/.claude`, desligue
o isolamento com `"isolateHome": false`.

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
configuração, e o agente não o recebe. O setup da verificação roda sobre o
commit do agente e por isso não tem o `HOME` do usuário: se ele precisa de um
token de registry privado, libere só esse token no `passEnv` do comando de
setup.

Em [`examples/inbox`](examples/inbox) há três solicitações: uma clara e
aprovada, com print (REQ-101); uma aprovada mas ambígua, que deve terminar em
`blocked` (REQ-102); e uma sem aprovação, que é ignorada (REQ-103).

## Testes

```bash
npm run check   # typecheck + 159 testes
```

- **Unitários** para cada peça: a função `decide` em todas as combinações, o
  contrato do runner (crash, timeout, status inválido), o prompt (variações da
  tag delimitadora, placeholders), o sandbox (com git real: commit funciona,
  push não), ledger, lock (inclusive a troca de dono no meio da tomada),
  escopo e o `exec` (grupo de processos, neto destacado, processo deixado em
  segundo plano).
- **Git real contra cada ataque da revisão**: hooks plantados no repositório do
  agente, remote e fsmonitor reescritos, a ref da base movida para esconder um
  `.env`, a branch movida depois da coleta, um filtro que tenta usar o `$HOME`,
  hooks de template do usuário, push URL alterado durante o run e mais de um
  push URL.
- **Pipeline** com fakes para todos os desfechos, idempotência, lock,
  recuperação de crash, falha isolada por solicitação e anexos fora da pasta
  ou via symlink.
- **Ponta a ponta com git real**: remote bare, repositórios e pushes reais, e um
  [agente falso](test/fixtures/fake-agent.mjs) que se comporta como o
  `claude -p`. Cobre cada desfecho, inclusive um agente que tenta fazer push
  sozinho e ler segredos, um que deixa um arquivo ignorado para "ajudar" o
  gate, um que esconde um `.env` movendo a base, um que planta hooks e config,
  e o `HOME` isolado — sem gastar crédito de API.

## Estrutura

```
src/
├── cli.ts          # poll · status · retry
├── pipeline.ts     # orquestra um poll e um run
├── gates.ts        # gates + decide()
├── sandbox.ts      # ambiente do agente e dos gates
├── agent/          # prompt a partir do roteiro + runner headless
├── git.ts          # repositórios do agente, coleta do SHA, evidência, push
├── scope.ts        # caminhos proibidos e de atenção, nome de branch
├── state/          # ledger e lock
├── source.ts       # fonte de solicitações (pasta)
├── notify.ts       # console e Telegram
├── exec.ts         # único ponto que cria processos
└── config.ts · request.ts · deps.ts
playbook/agent-playbook.md   # o roteiro que o agente segue
```

## Limitações conhecidas e próximos passos

- Uma solicitação por vez. Paralelizar exige uma fila e um limite de
  repositórios simultâneos — o ledger e o lock já isolam o estado por solicitação.
- O desfecho é um push de branch; abrir o PR automaticamente, com o relatório
  como descrição, é o próximo passo natural.
- Cada run cria dois repositórios rasos (o do agente, com os últimos 50
  commits da base, e o da verificação, só com o commit checado) e refaz o
  setup: mais lento que um worktree, mas é o que separa o agente do clone
  principal e garante que o commit publicado é o mesmo que passou nos gates,
  num checkout limpo.
- **git-lfs ainda não é suportado**: os repositórios novos não têm um remote
  LFS de onde baixar o conteúdo. Repositórios que dependem de LFS nos testes
  precisam de um passo de setup próprio.
- Dependências privadas via `git+ssh` funcionam no setup antes do agente, mas
  não na verificação, que roda sem as chaves do usuário de propósito. Prefira
  registry com token (liberado no `passEnv` do setup).
- Métricas que valem acompanhar: taxa de `published` aceito sem retrabalho na
  revisão, lead time da aprovação até a branch, apontamentos da revisão humana
  por entrega e taxa de `blocked` legítimo.

As decisões de projeto, inclusive o que ficou de fora de propósito, estão em
[DECISIONS.md](DECISIONS.md).

## Trabalhando neste repositório com IA

O [`CLAUDE.md`](CLAUDE.md) descreve os invariantes que não podem regredir, e
[`.claude/agents/guardiao-invariantes.md`](.claude/agents/guardiao-invariantes.md)
é um agente revisor que confere um diff contra eles antes do commit. Os dois
são versionados de propósito: fazem parte de como o projeto é mantido.

## Licença

[MIT](LICENSE)
