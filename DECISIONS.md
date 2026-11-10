# Decisões de projeto

Cada decisão com o porquê — inclusive o que foi decidido **não** fazer.

As decisões 12 a 15 nasceram depois da primeira versão: de uma revisão
independente do código, feita antes da publicação, e de um smoke test com o
Claude Code real. O histórico de commits mostra cada correção com o teste que
a prova.

## 1. Orquestrador determinístico, IA só no miolo

Detecção, repositórios, gates, push e notificação são código comum. O LLM entra
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
`REPORT.md`, em `contract/` dentro da pasta do run, nunca no repositório. Só
`contract/` e `attachments/` são liberadas com `--add-dir`; os arquivos de
auditoria do orquestrador ficam fora do alcance declarado do agente.

Os dois arquivos são lidos com `O_NOFOLLOW`, precisam ser arquivos regulares e
ter até 256 KB. Um `REPORT.md` trocado por symlink para `~/.ssh/id_ed25519`
vira `failed`, sem o conteúdo chegar à notificação. Os arquivos de auditoria
são sempre criados do zero (`O_CREAT | O_EXCL`), então um symlink plantado no
lugar de `evidence.json` não desvia a escrita. Com o agente no mesmo usuário
do SO, isso fecha o caminho direto, não um agente determinado a burlar.

**Por quê:** é o contrato mais simples que um humano consegue depurar com `cat`.
Ficar fora do repositório evita que o contrato vá parar num commit. Qualquer
desvio (arquivo ausente, valor inválido, crash, timeout, sessão com erro) vira
`failed` — o contrato é estrito porque a decisão depende dele.

## 4. A autodeclaração é precondição, não prova

O push exige `implemented` **e** commit novo **e** nada sem commit **e** nenhum
caminho proibido **e** gates verdes reexecutados pelo orquestrador. A decisão é
uma função pura.

**Por quê:** modelos declaram sucesso com confiança mesmo quando não há
sucesso. Cada condição corresponde a um modo real de falha: "fiz" sem commit,
alteração esquecida fora do commit (os testes rodariam sobre algo diferente do
publicado), toque em segredo, suíte vermelha. Ser pura permite testar todas as
combinações sem git nem processo.

## 5. Nada pode sobrar sem commit

Se sobrar arquivo sem commit, o resultado é `rejected`, mesmo com gates verdes.

**Por quê:** sobra sem commit quase sempre é entrega incompleta (o agente
esqueceu um arquivo). Publicar o commit sem ela entregaria outra coisa que não
a que o agente testou.

## 6. Gates rodam até o fim; e só quando vale

Todos os gates rodam, mesmo após a primeira falha. Mas eles nem começam se a
evidência barata (status, commit, sobras, escopo) já descarta a publicação.

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

## 12. Verificar num checkout novo, no commit exato, e publicar esse SHA

Depois do agente, o orquestrador anota o SHA, cria um checkout novo só com ele
(hoje um repositório à parte; veja a decisão 16), roda o setup e os gates ali,
e faz push exatamente daquele SHA, a partir do clone principal.

**Por quê:** na primeira versão, os gates rodavam no worktree do próprio agente,
e o push enviava o que a branch apontasse no momento. Dois problemas: testes
escritos pelo agente podiam mover a branch durante os gates, e arquivos
ignorados deixados por ele (um gerado, um `node_modules` alterado) podiam fazer
a suíte passar num estado que quebra num checkout limpo. O custo é refazer o
setup; o ganho é que o commit publicado é exatamente o que passou nos gates,
num checkout limpo. Fazer o push do clone principal também resolve o remote
como configurado — no smoke test real, um
remote com caminho relativo quebrava o push feito de dentro do worktree.

## 13. Sandbox de ambiente para o agente e para os gates

O agente e os gates recebem só uma allowlist de variáveis (mais `passEnv`), e o
git roda com `protocol.allow=never`.

**Por quê:** com `Write` e `npm test` liberados, o agente consegue executar
qualquer código: bastava escrever um script de teste que fizesse `git push`,
contornando a decisão, ou que lesse o token do Telegram do ambiente. Bloquear
`Bash(git push:*)` na allowlist não cobre isso. Sem segredos no ambiente e
sem transporte para os comandos git do agente, o caminho direto fecha.

**Limite assumido:** variáveis de ambiente valem para o processo, não contra
ele: um script do agente pode rodar `env -u GIT_CONFIG_COUNT git push` e o
transporte volta. Por isso a segurança da publicação não se apoia aqui (veja
as decisões 16 e 18). Nada disso substitui usuário dedicado ou container — o
README diz isso explicitamente.

O setup que roda **antes** do agente, sobre a base intacta, mantém o transporte
git (dependências via git quebrariam sem ele); o setup da verificação, que roda
sobre o commit do agente, não.

## 14. Caminhos proibidos conferidos com renames e nomes crus

O diff é lido com `--no-renames -z`.

**Por quê:** `git diff --name-only` mostra só o destino de um rename (mover
`.env.production` para um nome inocente escondia o arquivo) e põe aspas em
nomes com acento (`"\303\247/.env"` não casava com nenhum padrão).

## 15. `workDir` fora do repositório alvo e do orquestrador

O padrão é uma pasta por repositório em `~/.local/state`; dentro do alvo ou do
orquestrador, a configuração é recusada.

**Por quê:** o Claude Code lê `CLAUDE.md` subindo pelas pastas. Com o
diretório de trabalho do agente dentro do orquestrador, o agente recebia as instruções do
orquestrador como se fossem do projeto alvo.

## 16. O agente trabalha num repositório próprio, não num worktree

Cada solicitação ganha um repositório novo (`git init` + `fetch` do SHA da
base, vindo do clone principal). Quando o agente termina, o orquestrador traz o
`HEAD` dele com `git fetch` para `refs/evidence-gated-agent/<id>` no clone
principal; a verificação acontece em outro repositório novo, só com esse
commit. O orquestrador nunca roda git com o próprio ambiente dentro de um
diretório que o agente escreveu: o `status` e o checkout da verificação usam o
ambiente do sandbox, sem a config global do usuário.

**Por quê:** a re-revisão mostrou que o worktree compartilhava `.git/hooks`,
`.git/config` e refs com o clone principal. O agente podia plantar um
`post-checkout` (que rodaria no `worktree add` da verificação, com o ambiente
completo do orquestrador) ou um `pre-push`, trocar `remote.origin.url`, pôr um
comando em `core.fsmonitor` que o próximo `git status` executaria, ou apontar o
arquivo `.git` do worktree para um diretório git forjado. Repositórios com
husky (`core.hooksPath=.husky`) caíam no mesmo caso.

A primeira correção foi pontual: hooks e fsmonitor desligados, push URL anotado
antes do agente, snapshot do `.git/config` restaurado depois dele. O review
seguinte mostrou que cada medida tapava uma peça compartilhada e deixava outras
abertas — refs, o ponteiro `.git`, um config somente leitura que a restauração
não conseguia desfazer, um snapshot que só existia em memória. Separar os
repositórios tira o estado compartilhado do caminho, e o mecanismo de
snapshot deixou de existir.

A coleta começou com `git fetch` do repositório do agente (`upload-pack` é
feito para servir repositórios não confiáveis). Para o modo container, nem isso
podia rodar no host: hoje o `git bundle create HEAD ^<base>` roda com a
isolação do agente, sem rede, num diretório próprio fora do workspace; o host
confere que o bundle é um arquivo regular, que ele traz só `HEAD` no SHA
esperado, e grava o pack com `git index-pack --strict`, que roda fsck em cada
objeto. Só um HEAD que é a base ou um ancestral dela dispensa o bundle.

A revisão desta etapa achou três brechas, corrigidas:

- O `fetch` de um bundle não roda fsck no git anterior ao 2.47, mesmo com
  `transfer.fsckObjects`: um commit malformado entrava no clone principal. Daí
  o `index-pack --strict`.
- Com um `refs/replace/<X>` apontando para o próprio commit e X escrito no
  HEAD, o `rev-parse` do workspace respondia X, um commit que o clone
  principal tinha em outra branch, e a coleta pulava o bundle. O git no
  workspace roda com `GIT_NO_REPLACE_OBJECTS=1`, e o atalho sem bundle vale só
  para o histórico da base.
- Um `.git` trocado por um arquivo `gitdir: <clone principal>/.git` apontava o
  git do orquestrador para outro repositório. O workspace precisa ter `.git`
  como diretório.

O git que o orquestrador roda dentro desses diretórios recebe um `HOME`
descartável, sem config global nem de sistema: um filtro que o agente plantou
no próprio `.git/config` roda com o privilégio do agente e não alcança os
dotfiles do usuário. Os repositórios nascem com `--template=`, sem os hooks de
template do usuário.

**Custo:** criar repositórios a cada run é mais lento que um worktree. Para não
copiar o histórico inteiro, os dois recebem os últimos 50 commits — a
verificação chegou a receber só um, mas aí um gate que olha `HEAD~1` reprovava
um commit correto.

## 17. Toda evidência sai de dois SHAs anotados; nada do agente sobrevive a ele

O `fetch` anota o SHA da base e os push URLs do remote antes do agente rodar;
a coleta anota o SHA do agente uma vez. `commitsAhead`, `changedFiles`, a
verificação e o push recebem esses valores explicitamente (e recusam o que não
for um SHA completo). O push é recusado se os URLs mudaram durante o run, e é
feito pelo nome do remote: empurrar para a URL já reescrita faria o git
aplicar as regras `insteadOf` uma segunda vez, e o commit poderia ir para
outro lugar. A ref privada da coleta é apagada no fim do run, exceto em
`ready`, em que o commit espera um push manual. O
`exec` ganhou `killGroupOnExit`, usado para o agente e para os gates.

**Por quê:** antes, o diff e a contagem de commits liam refs no momento. Um
processo deixado em segundo plano podia mover a branch entre as checagens, e o
agente podia mover `origin/main` para cima de um commit que mexia em `.env` —
o diff contra a base movida mostraria só o commit inocente seguinte, e os dois
seriam publicados. Comparar contra SHAs anotados torna a ordem e as refs
irrelevantes; matar o grupo de processos na saída normal tira o processo
residual de cena. Anotar os push URLs fecha o último caminho em que uma config
reescrita durante o run decidiria para onde o commit vai.

## 18. `HOME` vazio para o agente e para a verificação

Por padrão (`isolateHome`), o agente recebe um `HOME` novo e vazio ao lado do
seu repositório, e a verificação (setup e gates sobre o commit dele) recebe
outro; os dois são apagados com o repositório. O Claude Code autentica por
`ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN` (de `claude setup-token`),
repassados ao agente só quando o `HOME` é isolado — com o `HOME` do usuário,
o login da assinatura tem de continuar valendo sobre uma chave de API que por
acaso esteja exportada. `XDG_CONFIG_HOME` e `CLAUDE_CONFIG_DIR` saíram da
allowlist.

O setup que roda **antes** do agente, sobre a base intacta, é código
confiável e mantém o `HOME` do usuário: sem as chaves SSH e os tokens de
registry dele, dependências privadas quebrariam toda solicitação.

**Por quê:** com o `HOME` do usuário, um script de teste do agente podia
escrever no `~/.gitconfig` um `pushInsteadOf` ou um `credential.helper` — e
todo comando git do orquestrador lê esse arquivo com o ambiente completo. O
mesmo vale para `~/.npmrc`, `~/.ssh` e `~/.claude`. Um `HOME` por run também
impede que um run contamine o seguinte — e por isso não há cache de pacotes
compartilhado. Uma versão anterior compartilhava o cache do npm; a revisão
mostrou que o npm só confere a integridade dos tarballs, não do `_npx` nem de
dependências sem hash no lockfile, e um agente podia deixar código para o
próximo run executar.

Também houve uma checagem de credencial na largada, que derrubava o poll
inteiro sem entrada no ledger nem notificação, e recusava provedores válidos
(Bedrock, Vertex). Saiu: quando o agente falha, o motivo registrado traz a
mensagem do próprio Claude Code, e a falha segue o caminho normal de
`failed` com notificação.

**Limite assumido:** o agente roda com o mesmo usuário do poll. Um script dele
ainda pode escrever por caminho absoluto num arquivo desse usuário. O que este
projeto fecha são os caminhos a partir de onde o agente trabalha; o resto é
papel do usuário dedicado ou do container (decisão 19).

## 19. Modo container: cada comando não confiável num container novo

`isolation.mode = "container"` roda o agente, o setup e os gates sobre o
commit dele e todo git dentro do repositório dele com `docker run`, um
container por comando. O padrão continua `none`.

**Por quê:** as decisões 16 a 18 fecham os caminhos que o agente tem a partir
de onde trabalha; sobrava o caminho absoluto, com o mesmo usuário. No
container, o clone principal, o `HOME` do usuário, o ledger e a auditoria não
existem: não há caminho para eles.

**Como:**

- A interface `Isolation` (`exec` com `mounts` e `network`) veio antes do
  container. Cada chamada declara o que precisa; o modo `none` ignora a
  declaração, o modo container a aplica. Assim o pipeline é o mesmo nos dois
  modos, e um teste garante que nenhum git do orquestrador roda dentro do
  repositório do agente fora dela.
- Mounts nos mesmos caminhos do host: prompt, `--add-dir`, `HOME` e a saída do
  git valem dentro e fora sem tradução de caminho.
- Usuário do host (`--user uid:gid`), para que os arquivos criados no
  container continuem do usuário do poll, sem `chown` nem root. Sem entrada no
  `/etc/passwd` da imagem, o `os.userInfo()` do Node falha: o orquestrador
  monta passwd e group mínimos, só leitura. Rodar o poll como root é recusado.
- `--cap-drop ALL`, `no-new-privileges`, raiz somente leitura, `/tmp` em tmpfs
  (`exec`: o padrão do docker é `noexec`, que quebra builds nativos),
  limites de memória e de processos, `--pull never` (a imagem é a que foi
  construída e revisada, nunca a que o registry tiver agora) e entrypoint
  vazio.
- Segredos por referência (`-e NOME`, com o valor no ambiente do CLI do
  docker), para não aparecerem no `ps`. `PATH`, `SHELL`, `TMPDIR` e caminhos de
  CA são do host e ficam fora.
- Rede por papel; `host` é recusada (daria acesso ao `localhost` do host). Os
  gates começam sem rede; o git no repositório do agente nunca tem rede.
- Matar o CLI do docker não para o container: num timeout ou erro do docker o
  orquestrador faz `docker rm -f`, e no sinal remove os que estiverem ativos.
  Contra `SIGKILL`, os containers levam o rótulo do `workDir`, e o primeiro
  container de cada poll (já com o lock) remove os que sobraram.

A revisão desta etapa corrigiu, além da coleta (decisão 16): o `/tmp` em
`noexec`; toda variável `GIT_*` indo em texto claro na linha de comando (hoje
só os nomes que o próprio orquestrador define); uma `image` começando com `-`,
que o docker leria como opção; e um diretório temporário mais uma chamada ao
docker em todo poll, mesmo sem trabalho.

O smoke real no container achou mais um: com o `workDir` abaixo de
`/tmp/claude-1001/`, o docker cria `/tmp/claude-1001` dentro do container,
com dono root, como ponto de montagem — e o Claude Code se recusa a usar como
pasta temporária uma que não é do usuário. O `TMPDIR` do container passou a
ser um tmpfs próprio (`/run/ega-tmp`), fora de qualquer caminho do host.

**Ficou no host:** o setup confiável sobre a base intacta (pode precisar das
chaves do usuário) e o checkout da verificação, que roda num repositório novo
do orquestrador, sem nenhum filtro definido.

**Tentativa descartada:** `bubblewrap`, mais leve que o Docker, não sobe no
Ubuntu 24.04 por causa da restrição do AppArmor a user namespaces sem
privilégio. Exigir que o usuário mude uma política de segurança do sistema
para usar o projeto seria pior que depender do Docker.

**Limites assumidos:** o kernel é compartilhado (para código hostil de verdade,
VM ou gVisor); quem está no grupo `docker` equivale a root no host — o poll já
tem esse poder, o agente não vê o socket; o agente tem rede para a API e pode
mandar para fora o que enxerga, e a rede `bridge` alcança também o host, a
rede local e o metadata de nuvem — em produção, uma rede docker própria com
saída restrita.

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
