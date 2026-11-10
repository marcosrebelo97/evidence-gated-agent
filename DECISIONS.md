# Decisões de projeto

Cada decisão com o porquê — inclusive o que foi decidido **não** fazer.

As decisões 12 a 15 nasceram depois da primeira versão: de uma revisão
independente do código, feita antes da publicação, e de um smoke test com o
Claude Code real. O histórico de commits mostra cada correção com o teste que
a prova.

## 1. Orquestrador determinístico, IA só no miolo

Detecção, worktree, gates, push e notificação são código comum. O LLM entra
apenas onde há raciocínio: interpretar o pedido e os prints, e implementar.

**Por quê:** cada etapa determinística é testável, auditável e não custa token.
Colocar um modelo para decidir "posso fazer push?" trocaria uma regra
verificável por uma opinião.

## 2. Sem framework de agentes

O agente é o Claude Code em modo headless (`claude -p`), que já traz
ferramentas, sandbox de permissões e sessão. O orquestrador só o invoca.

**Por quê:** um framework adicionaria abstração sem resolver nada que o caso
precisa. Ele passa a fazer sentido com vários agentes cooperando ou com fila e
roteamento — e aí a fronteira já está clara: substitui-se o `AgentRunner`.

## 3. Contrato por arquivos (`STATUS` + `REPORT.md`)

O agente escreve uma palavra em `STATUS` e um relatório em pt-BR em
`REPORT.md`, na pasta do run (liberada com `--add-dir`), nunca no repositório.

**Por quê:** é o contrato mais simples que um humano consegue depurar com `cat`.
Ficar fora do worktree evita que o contrato vá parar num commit. Qualquer
desvio (arquivo ausente, valor inválido, crash, timeout, sessão com erro) vira
`failed` — o contrato é estrito porque a decisão depende dele.

## 4. A autodeclaração é precondição, não prova

O push exige `implemented` **e** commit novo **e** worktree limpo **e** nenhum
caminho proibido **e** gates verdes reexecutados pelo orquestrador. A decisão é
uma função pura.

**Por quê:** modelos declaram sucesso com confiança mesmo quando não há
sucesso. Cada condição corresponde a um modo real de falha: "fiz" sem commit,
alteração esquecida fora do commit (os testes rodariam sobre algo diferente do
publicado), toque em segredo, suíte vermelha. Ser pura permite testar todas as
combinações sem git nem processo.

## 5. Worktree limpo é exigido

Se sobrar arquivo sem commit, o resultado é `rejected`, mesmo com gates verdes.

**Por quê:** sobra sem commit quase sempre é entrega incompleta (o agente
esqueceu um arquivo). Publicar o commit sem ela entregaria outra coisa que não
a que o agente testou.

## 6. Gates rodam até o fim; e só quando vale

Todos os gates rodam, mesmo após a primeira falha. Mas eles nem começam se a
evidência barata (status, commit, worktree, escopo) já descarta a publicação.

**Por quê:** quem revisa um `rejected` quer ver tudo o que está vermelho de uma
vez. E não faz sentido gastar minutos de suíte num run que já não pode ser
publicado.

## 7. `blocked` é um desfecho próprio

O roteiro manda parar diante de ambiguidade e devolver perguntas numeradas. O
orquestrador trata `blocked` separado de `failed`, sem push e sem gates.

**Por quê:** um agente que bloqueia certo vale tanto quanto um que implementa
certo. Misturar os dois esconderia a métrica mais útil para melhorar a
qualidade das solicitações.

## 8. Ledger em JSON com escrita atômica, não banco

Um arquivo, gravado via arquivo temporário + `rename`, protegido pelo lock do
poll.

**Por quê:** o volume é de dezenas de solicitações, não milhares. Um banco
traria dependência nativa e operação sem ganho. O `rename` é atômico no mesmo
sistema de arquivos, então um crash nunca deixa o ledger pela metade. Ledger
corrompido falha alto em vez de recomeçar do zero — recomeçar faria tudo rodar
de novo.

## 9. Run interrompido vira `failed`, nunca é retentado sozinho

Com o lock em mãos, uma entrada `running` só pode ser de um processo que morreu.
Ela vira `failed` com o motivo.

**Por quê:** retentar automaticamente pode repetir um efeito parcial (por
exemplo, um push que chegou a acontecer). A nova tentativa é uma decisão
humana, explícita: `npm run retry -- <id>`. Cada tentativa ganha sua própria
pasta, então a anterior continua auditável.

## 10. Nenhum processo passa por shell

Tudo é criado com `spawn(command, args, { shell: false })`, num grupo de
processos próprio.

**Por quê:** texto de solicitação nunca pode virar comando. O grupo próprio
garante que o timeout derrube também o que o agente iniciou (testes, servidores).

## 11. Branch própria, `-B` e push sem força

O agente trabalha em `agent/<id>-<slug>`, criada com `-B` a partir da base
remota. O push nunca usa `--force` e recusa a branch base.

**Por quê:** `-B` faz um retry partir da base atual, não de uma tentativa velha.
Sem `--force`, um retry de algo já publicado falha em vez de reescrever uma
branch que alguém pode estar revisando.

## 12. Verificar num worktree novo, no commit exato, e publicar esse SHA

Depois do agente, o orquestrador anota o SHA, cria um worktree destacado nele,
roda o setup e os gates ali, e faz push exatamente daquele SHA, a partir do
clone principal.

**Por quê:** na primeira versão, os gates rodavam no worktree do próprio agente,
e o push enviava o que a branch apontasse no momento. Dois problemas: testes
escritos pelo agente podiam mover a branch durante os gates, e arquivos
ignorados deixados por ele (um gerado, um `node_modules` alterado) podiam fazer
a suíte passar num estado que quebra num checkout limpo. O custo é refazer o
setup; o ganho é que o verificado é o publicado. Fazer o push do clone
principal também resolve o remote como configurado — no smoke test real, um
remote com caminho relativo quebrava o push feito de dentro do worktree.

## 13. Sandbox de ambiente para o agente e para os gates

O agente e os gates recebem só uma allowlist de variáveis (mais `passEnv`), e o
git roda com `protocol.allow=never`.

**Por quê:** com `Write` e `npm test` liberados, o agente consegue executar
qualquer código: bastava escrever um script de teste que fizesse `git push`,
contornando a decisão, ou que lesse o token do Telegram do ambiente. Bloquear
`Bash(git push:*)` na allowlist não cobre isso. Sem transporte git e sem
segredos no ambiente, publicar volta a ser exclusividade do orquestrador.

**Limite assumido:** o agente precisa do `HOME` para as credenciais do Claude
Code. Isso não substitui usuário dedicado ou container — o README diz isso
explicitamente.

## 14. Caminhos proibidos conferidos com renames e nomes crus

O diff é lido com `--no-renames -z`.

**Por quê:** `git diff --name-only` mostra só o destino de um rename (mover
`.env.production` para um nome inocente escondia o arquivo) e põe aspas em
nomes com acento (`"\303\247/.env"` não casava com nenhum padrão).

## 15. `workDir` fora do repositório alvo e do orquestrador

O padrão é uma pasta por repositório em `~/.local/state`; dentro do alvo ou do
orquestrador, a configuração é recusada.

**Por quê:** o Claude Code lê `CLAUDE.md` subindo pelas pastas. Com os
worktrees dentro do orquestrador, o agente recebia as instruções do
orquestrador como se fossem do projeto alvo.

## O que decidi não fazer (por enquanto)

- **Abrir PR automaticamente.** O push de branch já entrega o essencial para a
  revisão; o PR com template é o próximo passo.
- **Paralelismo.** Uma solicitação por vez mantém o custo e a carga de revisão
  previsíveis. O estado já está isolado por solicitação para quando houver fila.
- **Retry automático.** Ver decisão 9.
- **Gate de code-review por IA fora do agente.** O review do próprio diff está
  no roteiro (etapa 7). Um gate externo de review por IA pode ser plugado como
  mais um comando em `gates`, mas não substitui os gates objetivos.
- **Cliente para um sistema de tickets específico.** `RequestSource` é a
  interface; a implementação por pasta serve para o padrão ficar demonstrável
  sem acoplar a um produto.
