# agy-staff — Referência completa

Voltar ao [README](../README.pt-BR.md). Veja a [referência em inglês](REFERENCE.md).

## Modos e padrões

| Persona (skill) | Modo do companion | O que é | Modelo padrão | Perfil | Execução |
|---|---|---|---|---|---|
| `ask` | `ask` | Q&A síncrono, barato e sem ferramentas (~3s); também funciona como smoke test pós-instalação | `gemini-3.8-flash-low` | restricted (só prompt) | síncrono — a resposta volta na mesma chamada |
| `staffer` | `staffer` | Delegação de uso geral, sem papel especialista nem formato de saída fixo; os guardrails operacionais compartilhados continuam valendo | `gemini-3.8-flash-medium` | unrestricted | job em segundo plano — retorna um job id |
| `researcher` | `research` | Survey aprofundado com fontes citadas e marcação explícita de afirmações não verificadas | `gemini-3.8-flash-high` | unrestricted | job em segundo plano — retorna um job id |
| `reviewer` | `review` | Verificador de segunda opinião, em dois sabores roteados pelo assunto: code review (achados classificados por severidade com referências `file:line`) e review geral (desafio multiângulo de um plano, design ou decisão) | `gemini-3.8-flash-medium` | unrestricted | job em segundo plano — retorna um job id |
| `implementer` | `implement` | Tarefa de código com escopo bem definido; o agy edita a working tree e pode executar entrega via Git explicitamente solicitada | `gemini-3.8-flash-high` | unrestricted | job em segundo plano — retorna um job id |
| `pool` | `workers` | Inspeção opt-in de workers: lista os workers AGY descobertos, ou passa `--worker <id>` ao despachar outra persona para seleção explícita | — | n/a — nenhuma invocação do agy | síncrono — imprime a tabela de workers na mesma chamada |

O `lead` fornece orientação de orquestração de tarefas para o agente atual, reaproveitando os modos existentes do companion sem adicionar um modo próprio; invoque `/agy:lead` no Claude Code, `$agy:lead` no Codex, ou `/skill:agy-lead` no Pi.

O estilo de execução é fixo por modo e não pode ser sobrescrito por flag. `continue` herda o estilo do modo resolvido (continuar um `ask` permanece síncrono; continuar os demais retorna um job id).

Claude Code, Codex e Pi expõem as mesmas personas, apoiadas em um único script companion (`companion/agy-companion.mjs`, apenas stdlib do Node) e templates de prompt compartilhados (`templates/`). Tokens de invocação: `/agy:<persona>` no Claude Code, `$agy:<persona>` no Codex, e `/skill:agy-<persona>` no Pi. O manifesto do Pi expõe somente `pi-skills/`, gerado mecanicamente a partir de `skills/` (canônico) via `npm run generate:pi`. As skills geradas usam o prefixo `agy-`, reescrevem referências entre skills irmãs, e anexam `templates/harness-compatibility.md` (instruindo o host a adaptar ferramentas ausentes para métodos equivalentes sem abrir mão de requisitos, ou pedir ajuda). A gestão de jobs (`wait`/`status`/`result`/`cancel`/`continue`/`setup`) mora em `jobs` (`agy-jobs` no Pi) mais a CLI do companion — peça em linguagem natural ("is the agy job done?").

## Pool de workers opcional

O caminho normal continua sendo um único worker, resolvido como `AGY_BIN || agy`. A skill opt-in `pool` expõe `workers` para inspeção e `--worker <id>` para seleção explícita; as demais skills permanecem inalteradas. A descoberta verifica `AGY_BIN`, `AGY_POOL_BINS`, `agy`/`agy2`/`agy3` no `PATH`, e por fim o `.agy-staff/config.json` opcional. O Node não consegue descobrir aliases ou funções de shell; use wrappers executáveis ou caminhos explícitos. Os jobs registram id do worker, executável e versão quando disponíveis; `continue` e `restart` preservam a afinidade, enquanto jobs legados usam `AGY_BIN || agy`. A saída do dispatch, o status da listagem, os snapshots do observe e os diagnósticos incluem a identidade do worker, para que todo host apresente o contexto de worker externo de forma consistente sem mudar o texto do resultado entregue. A capacidade padrão é um job ativo por worker. Tarefas independentes podem rodar em paralelo; tarefas dependentes ficam sequenciais, e escritas em paralelo exigem worktrees separadas ou autorização explícita. `workers` reporta id, executável, disponibilidade, versão e contagem de jobs ativos.

## O modelo de permissão de dois perfis

Todo modo roda sob exatamente um de dois perfis. **Todo modo que usa ferramentas assume `unrestricted` por padrão**, então o plugin funciona de imediato, sem allowlist e sem setup; `--restricted` é a flag de reforço opt-in. `--restricted`/`--unrestricted` sobrescrevem por chamada (`ask` não usa ferramentas e é forçado a restricted — ele ignora as duas, e passar `--unrestricted` para ele imprime um aviso e segue restricted mesmo assim).

O perfil de uma execução é resolvido nesta ordem: flag de CLI > perfil de conversa gravado (ao continuar) > política por repositório ([`setup --restrict`](#política-por-repositório-setup---restrict)) > padrão embutido.

| | **unrestricted** (padrão: staffer, research, review, implement) | **restricted** (reforço opt-in; forçado para o ask) |
|---|---|---|
| Invocação do agy | `--dangerously-skip-permissions` | sem pular permissões — fail-closed, toda chamada de ferramenta não listada é automaticamente negada |
| O que o agy pode fazer | qualquer coisa, incluindo editar arquivos e rodar comandos | leituras de arquivo no workspace mais `git gh cat head ls grep find rg wc`, com cinco prefixos de negação de git/gh direcionados (regras de permissão do AGY) |
| Rede de segurança | guardrails em nível de prompt (negação por padrão em ações irreversíveis/custosas) + as guardas de git em camadas abaixo | o agy fica dentro da própria aplicação de permissões do agy |
| Uso típico | o caminho normal: Q&A, surveys, reviews, tarefas de código | execuções endurecidas: entrada não confiável, ou máquinas onde pular os prompts de permissão do agy é inaceitável |

`--restricted` e `--unrestricted` são mutuamente exclusivas; passar as duas é um erro. Duas coisas para saber antes de endurecer: `--restricted` só é útil depois que a allowlist do setup estiver instalada (senão o agy nega até a própria coleta de evidências e a execução volta vazia), e algumas ferramentas nativas ignoram completamente as regras de permissão em modo headless — uma execução restricted pode voltar mais rasa do que uma unrestricted.

### Guardas do git em camadas

As guardas se aplicam **somente a execuções unrestricted** e variam por modo:

| Modo | Dentro de um repositório git | Fora de um repositório git |
|---|---|---|
| `implement` | workspaces sujos são permitidos. Se o repositório já tem mudanças, o companion adiciona ao prompt do agy um resumo curto do status pré-execução, para que ele saiba quais caminhos já foram tocados e precisa tratá-los como trabalho do usuário. O resumo tem limite de tamanho; o agy deve rodar `git status --porcelain` e inspecionar diffs quando a autoria não estiver clara. Depois, o companion reporta se o workspace ficou limpo, mudou, ou continua sujo | avisa que as edições do agy não podem ser revisadas nem revertidas via git, e segue em frente |
| `research`, `review` | nunca bloqueado, sem verificação de árvore limpa. O worker tira um snapshot de `git status --porcelain` antes da execução e compara depois; se o agy introduziu mudanças, o resultado carrega um aviso listando o delta mais uma dica de rollback | nada para comparar — silencioso |
| `staffer` | o mesmo snapshot/relatório de research/review, mas com tom neutro: uma tarefa geral pode legitimamente editar arquivos, então o delta é informação para quem chamou ("confirme se a tarefa pedia isso"), não uma acusação | nada para comparar — silencioso |

Silêncio é o caso normal para `research`/`review`: o aviso de delta só aparece quando o agy tocou a working tree, o que os templates instruem a não fazer.

### Guardrails em nível de prompt: negação por padrão, aberturas via prompt

Os templates de `staffer`, `research`, `review` e `implement` negam efeitos colaterais irreversíveis ou custosos **por padrão**:

- nenhum commit, push, escrita de PR ou reescrita de histórico, a menos que a tarefa peça explicitamente essa entrega Git exata;
- nenhuma exclusão de arquivos fora do workspace;
- nenhuma chamada de rede com efeito colateral;
- nenhum comando que consuma quota paga de API ou tokens (ex.: uma suíte e2e que cobra de uma API ao vivo).

Scripts de rascunho vão para um diretório temporário, e tudo o que a execução faz dentro do workspace permanece reversível via git.

**O padrão é fechado, não travado.** Se seu pedido autoriza explicitamente uma dessas operações ("commit this", "open a draft PR", "run the e2e tests", "call the staging API"), o agy faz exatamente o que foi autorizado e reporta o que executou — então passe essas autorizações ao delegar, palavra por palavra. O `review` em particular pode rodar comandos somente leitura, scripts de rascunho e testes para verificar um achado; o que ele não pode fazer é modificar arquivos versionados, commitar ou dar push.

### Disciplina de decisão e recusa do gate antes do despacho (somente `implement`)

O template do `implement` carrega uma seção `## Decision discipline`: reportar um fato do briefing contradito pelo código (com evidência `file:line`) em vez de contornar, preferir uma regra já existente do projeto a um fallback "robusto" inventado, nomear quem chega a um branch/caminho de código novo em produção, e respeitar o próprio orçamento de tempo da execução — nenhuma baseline completa de build/test/lint a menos que o briefing autorize explicitamente. A seção declara o timeout resolvido do job em palavras (ex.: "You have about 60 minutes.").

Antes do dispatch, o companion também varre o texto da tarefa em busca de uma **ordem positiva** para o próprio worker rodar um gate longo — `pnpm|npm|yarn|bun build|test|check|lint|typecheck`, `pytest`, `cargo test`/`build`, `go test`, um `tsc` isolado, ou `next build` — dentro de um bloco de código, um item de lista, ou uma frase imperativa ("run", "execute", "rode", "corra", "confirm with", "verify with", "then run"). Uma negação ("don't run", "não rode", "sem rodar") ou uma prosa descritiva que apenas cita o comando ("the CI runs pnpm build") não é uma ordem e é deixada de lado. Ao encontrar uma correspondência, o companion recusa antes de criar qualquer job e antes de o agy sequer ser invocado (exit 1), citando a linha em questão. Duas saídas: remover a ordem do briefing, ou passar `--allow-gate` para autorizar o worker a rodá-la. Essa verificação roda em toda fonte de texto de tarefa (`--prompt`, `--prompt-file`, `--stdin`) e no texto relido por `continue` e `restart`; um `--allow-gate` da execução original fica registrado no spec do job, então um `restart` simples de um job autorizado herda a autorização em vez de perguntar de novo.

### Gates declarados: verificação executada pelo companion (`implement`/`continue`/`restart`)

Enquanto `--allow-gate` autoriza o *worker* a rodar um gate por conta própria (dentro do próprio orçamento de tempo), os gates declarados fazem o *companion* rodar um ou mais comandos **depois** que o worker reporta done — nunca consumindo o orçamento do próprio agente, e nunca algo que o worker precise lembrar de fazer. Duas formas de declarar um gate para uma única execução:

- `--gate <nomes>` — uma lista separada por vírgula (`--gate check` ou `--gate check,build`; repetir `--gate` não é suportado pelo parser de flags, então a forma com vírgula é a que realmente funciona) procurada no mapa `gates` do `.agy-staff/config.json`: `{ "gates": { "check": "pnpm check", "build": "pnpm build" } }`. Cada valor precisa ser uma string de comando não vazia e de uma linha só. Um nome desconhecido, ou nenhum `gates` configurado, recusa **antes do dispatch** (exit 1, sem job, sem chamada ao agy), listando os nomes disponíveis e o caminho de config consultado.
- `--gate-cmd "<cmd>"` — um comando ad hoc de uma linha, sem precisar de entrada na config; roda depois de qualquer comando de `--gate` nomeado, na ordem dada.
- `--gate-timeout <dur>` — o orçamento de tempo próprio de cada gate, padrão 15m, totalmente separado do `--timeout` do próprio agente.

**Busca de configuração e o fallback de worktree.** Os gates nomeados são lidos primeiro do `.agy-staff/config.json` do próprio workspace atual. Uma `git worktree` vinculada normalmente não tem config própria (ela é git-ignorada, então `git worktree add` nunca a copia), então quando a config do workspace atual não carrega `gates`, a busca cai para a config da **worktree principal** (`git rev-parse --git-common-dir` → seu diretório pai). O fallback vale só para `gates` — a política de perfil (`setup --restrict`) não é afetada, e uma worktree mantém sua própria escolha de perfil.

**Quando os gates rodam.** Só nos dois desfechos que significam que o worker de fato terminou o trabalho: `done`, e `verification_incomplete` (veja abaixo — um gate que passa é evidência mais forte do que a própria afirmação de pendência do worker). Gates nunca rodam para `quota_exhausted`, `error`, um timeout (`response_timeout`/`hard_timeout`), `canceled`, `implement_no_changes`, ou `implement_uncommitted` — nenhum desses significa que o worker entregou algo para verificar. Enquanto um gate roda, o próprio `status` do job continua `running` (nada de novo para fazer polling), mas `phase: "verifying"` e `verifying_gate: "<name>"` aparecem no JSON de `status <id>`, no snapshot em execução do `observe`, e como um anúncio de uma linha no stderr de `wait --follow` toda vez que o gate em execução muda.

**Execução.** Os gates rodam na ordem dada e param na primeira falha ou timeout — um gate posterior nunca começa. Cada um roda com `shell: true` (então uma string de config como `pnpm check` não precisa de split de argv), no workspace do próprio job, com o ambiente de quem chamou, no seu próprio grupo de processo — morto como uma árvore inteira (os mesmos helpers cross-platform que o próprio processo do agy usa: grupos de processo POSIX, no Windows via uma consulta CIM à tabela de processos mais `taskkill /PID <pid> /F`, nunca `/T`) ao atingir seu próprio `--gate-timeout` ou ao cancelar o job (o mecanismo existente de polling de cancelamento se estende naturalmente a essa fase, então um cancelamento pedido enquanto um gate roda ainda termina o job como `canceled` e mata o gate). A saída (stdout+stderr combinados) tem um limite de cerca de 8 KiB por gate.

**Resultado.** O desfecho de cada gate fica registrado no job (`gate_results`: um array de `{name, command, exit, timed_out, duration_ms}`) e é reportado em uma seção `## Companion verification` — nome, comando, veredito de sucesso/falha/timeout, duração e a cauda limitada da saída — posicionada **antes** de `## Partial work`/dos diagnósticos JSON, quando algum dos dois está presente.

- **Todos os gates declarados passam:** `done` continua `done`. `verification_incomplete` também vira `done` — um gate declarado que passa supera a própria frase "ainda pendente" do worker — com uma nota de uma linha no relatório dizendo que a alegação de pendência foi superada pelo gate.
- **Algum gate falha ou expira:** o job termina em `attention`, motivo `gate_failed` (exit 5), com a resposta e o diff do worker preservados e uma seção `## Partial work` anexada (mesmo formato de todo outro relatório terminal que não seja `done` — veja abaixo).

**Herança.** `gates` e `gate_timeout` são persistidos no spec e no registro do job; `continue` e `restart` daquele job os herdam automaticamente — sem precisar repetir `--gate` em cada follow-up. Passar um novo `--gate`/`--gate-cmd` na continuação substitui a lista herdada por completo (procurada de novo na config atual), em vez de somar a ela. A recusa por ordem antes do dispatch do próprio `--allow-gate` (acima) não é afetada por nada disso: ela só varre o texto da tarefa, nunca os gates declarados, então declarar gates nunca a aciona.

### Revisando conteúdo não confiável

Sob `unrestricted`, prompt injection é execução de código. Se você apontar `review` ou `research` para conteúdo escrito por alguém em quem você não confia — um PR de um estranho, uma dependência vendorizada, o corpo de uma issue cheio de instruções —, o texto dentro desse conteúdo pode dizer ao agy para rodar comandos arbitrários, e um agy unrestricted vai rodá-los.

Duas mitigações, nenhuma delas o padrão:

- **`--restricted`** — a própria aplicação de permissões do agy passa a valer, então ferramentas não listadas são negadas automaticamente. As ressalvas continuam as mesmas: precisa da allowlist do setup para ser útil, a allowlist usa correspondência por prefixo em vez de ser somente leitura, e ferramentas nativas que ignoram as regras de permissão podem falhar-fechado e reduzir a review. Isso encolhe o raio de explosão; não é um sandbox.
- **Um checkout isolado** — revise em um clone descartável, container ou VM sem nenhuma credencial que valha a pena roubar.

O padrão otimiza para o caso comum: seu próprio código na sua própria máquina. Entrada não confiável é o caso em que você deve recorrer a uma das duas opções.

### Reforço opcional (setup)

`setup` é um comando opcional de gestão do companion, tratado pela skill `jobs`. Peça ao seu agente host para configurar o modo restricted do agy quando precisar. O comando verifica o binário `agy` e mostra em preview as **regras de allow/deny para coleta de evidências** para `~/.gemini/antigravity-cli/settings.json`. Só depois de confirmação explícita ele faz backup do arquivo e anexa a configuração. As tarefas unrestricted padrão e o ask sem ferramentas não dependem do setup.

Duas propriedades dessas regras que você deve saber antes de aplicá-las:

- **Ele permite comandos amplos com uma deny list pequena.** O setup mantém `command(git)` / `command(gh)` e adiciona prefixos de negação para `git push`, `git reset --hard`, `git clean`, `gh pr merge` e `gh release delete`. [O AGY avalia deny antes de ask antes de allow](https://www.antigravity.google/docs/cli/permissions/); o companion só instala configuração, sem parser de comandos nem allowlist por tarefa. Regras allow/deny/ask já existentes são preservadas. Aplicar o setup sobre uma configuração restrita anterior adiciona as concessões amplas mostradas no seu dry run. Esses prefixos evitam erros comuns, não todas as ações irreversíveis: outros arranjos de argumentos, aliases, scripts, APIs e outros comandos permitidos não são cobertos de forma abrangente. O setup não é uma fronteira somente leitura. Uma operação negada continua negada mesmo se pedida na tarefa; mude as configurações explicitamente quando necessário.
- **Ele é global.** O arquivo é `~/.gemini/antigravity-cli/settings.json`, então as regras valem para toda execução de `agy` na máquina, não só para jobs do agy-staff. Esse é o caminho intencional do produto ("configure uma vez, use em todo lugar").

A busca web não está na allowlist e não precisa estar: no agy testado (v1.1.13), `search_web` roda em modo headless sem precisar de uma regra allow.

### Política por repositório (`setup --restrict`)

Se você quer que alguns modos rodem restricted sempre *em um repositório específico* — digamos, um repositório onde você revisa rotineiramente PRs de estranhos —, você pode declarar isso uma vez em vez de lembrar da flag toda hora:

```bash
setup --restrict review,research   # esses modos passam a ser restricted por padrão neste repositório
setup --restrict none              # volta aos padrões embutidos
```

A política é escrita em `<repo>/.agy-staff/config.json` e aplicada automaticamente (a execução imprime uma nota dizendo que o perfil veio da política do projeto). Três propriedades:

- **Precedência.** Flags explícitas `--restricted`/`--unrestricted` sobrescrevem a política. Continuações sem uma sobrescrita explícita herdam o perfil gravado; tarefas novas usam a política do repositório ou os padrões embutidos. `ask` não usa ferramentas e é sempre restricted.
- **Escopo.** `.agy-staff/` normalmente é git-ignorado, então a política é uma preferência pessoal, por máquina — ela não é compartilhada com seu time através do repositório.
- **O que ela não é.** Isso é uma política de execução para consistência e prevenção de acidentes, não uma fronteira de segurança: ela alimenta o mesmo mecanismo de `--restricted`, com as mesmas ressalvas (precisa da allowlist global, correspondência por prefixo, algumas ferramentas ignoram regras allow em modo headless). Para entrada genuinamente não confiável, use um checkout isolado.

Note que os dois arquivos são coisas diferentes: as **regras de allow/deny** (o que um agy restricted pode executar) são globais por design do agy; a **política** (quais modos são restricted por padrão) é por repositório, por decisão nossa.

### Avançado: permissões com escopo de projeto

Se uma allowlist para a máquina inteira é ampla demais para você, o agy também suporta regras de permissão com escopo de projeto (ele as trata como prioridade máxima), amarradas ao seu sistema de `--project`. Isso permitiria conceder as regras de evidência só dentro dos repositórios onde você delega.

Ressalva, dita sem rodeios: **o caminho exato do arquivo de configurações de projeto não é documentado e não foi verificado contra a versão atual do agy**, então o agy-staff não o escreve e este documento não o adivinha. Se você quer escopo de projeto, verifique interativamente no `agy` de onde ele lê as regras de nível de projeto, e configure você mesmo. Até lá, ou aceite o escopo global ou pule o setup inteiramente — o perfil unrestricted padrão contorna o sistema de permissões do agy em vez de depender dele, e o `ask` não precisa de nenhuma allowlist; pular o setup só custa a capacidade de endurecer uma execução com `--restricted`.

## Flags (uniformes entre os modos)

| Flag | Significado |
|---|---|
| `--conversation <id>` | retoma uma conversa específica do agy |
| `--continue` | reaproveita o último id de conversa deste modo a partir do estado |
| `--model <id>` | modelo explícito do agy (veja `agy models`). Ids têm sufixo de esforço (`gemini-3.8-flash-low`); o companion normaliza famílias sem sufixo (`gemini-3.8-flash` + `--effort`) e os aliases `flash`/`pro`, e rejeita ids desconhecidos antes da execução |
| `--effort low\|medium\|high` | atalho para `gemini-3.8-flash-<effort>` |
| `--restricted` / `--unrestricted` | sobrescrita do perfil de permissão (ignorada pelo `ask`). `unrestricted` é o padrão para `staffer`/`research`/`review`/`implement`, então `--restricted` é a flag que você de fato vai usar |
| `--restrict <modes\|none>` | (setup) política por repositório: os modos listados passam a ser restricted por padrão neste repositório; `none` limpa isso. Veja [Política por repositório](#política-por-repositório-setup---restrict) |
| `--worker <id>` | (pool de workers opt-in) seleciona um worker descoberto específico por id para esta execução, ou `auto` para seleção automática por carga. Válido em `staffer`/`research`/`review`/`implement`/`ask`, `continue`, e `restart`; rejeitado com erro em `status`, `wait`, `result`, `cancel`, `observe`, `setup`, e `workers`, que nunca despacham para um worker. Veja [Pool de workers opcional](#pool-de-workers-opcional) |
| `--json` | (review) achados em JSON com schema obrigatório; o padrão é markdown livre. Pensado para o sabor de code review; válido em `review` e em `continue` (só tem efeito se o modo da conversa retomada for `review`), rejeitado com erro nos demais casos |
| `--timeout <dur>` | limite rígido do worker em segundo plano (padrão 60m, máximo 120m). O AGY recebe o timeout de resposta selecionado. Para o `ask` síncrono: timeout de resposta do AGY, padrão 2m. Também válido em `wait` (seu próprio timeout de polling soft, padrão 100s) e `restart` (um orçamento novo para o relançamento). Rejeitado junto com `--until-done` do `wait` — os dois configuram a mesma coisa de duas formas incompatíveis |
| `--follow` | (só `wait`) segue os eventos de passo do job no stderr enquanto faz o polling — `▶`/`✓`/`✗` por passo, com o nome da ferramenta e uma dica curta de parâmetro. O stdout do wait não muda de qualquer forma; sem `--follow`, o wait continua silencioso como antes. Só passos que acontecem depois desta chamada de `wait` são mostrados, nunca histórico de antes de ela começar. Compatível com `--until-done`. Também anuncia cada gate declarado ao começar a rodar (`verifying: running gate <name>`), já que o progresso de um gate não faz parte do stream de eventos do agy do job |
| `--until-done` | (só `wait`) bloqueia até o job chegar a um estado terminal, sem teto de timeout — nenhum valor de `--timeout` para escolher, e nenhum se aplica. Mutuamente exclusivo com `--timeout` (erro de uso, exit 1). Usa a mesma cadência de polling e detecção de crash de um wait comum, então um worker que morre no meio da execução ainda termina o wait como `crashed` em vez de travar. Veja [Wait, exit 2 e `--until-done`](#wait-exit-2-e---until-done) |
| `--allow-gate` | (`implement`/`continue`/`restart`) autoriza o worker a rodar um comando de gate longo (build/test/check/lint) que o briefing ordena — sem isso, uma ordem detectada recusa a execução antes do dispatch. Veja [Disciplina de decisão e recusa do gate antes do despacho](#disciplina-de-decisão-e-recusa-do-gate-antes-do-despacho-somente-implement) |
| `--gate <names>` | (`implement`/`continue`/`restart`) lista separada por vírgula de gates nomeados (mapa `gates` do `.agy-staff/config.json`) que o COMPANION roda depois que o worker termina. Nome desconhecido, ou nenhum configurado, recusa antes do dispatch. Veja [Gates declarados](#gates-declarados-verificação-executada-pelo-companion-implementcontinuerestart) |
| `--gate-cmd <cmd>` | (`implement`/`continue`/`restart`) um comando ad hoc de uma linha que o companion roda depois de qualquer comando de `--gate` nomeado; rejeita um valor de múltiplas linhas |
| `--gate-timeout <dur>` | (`implement`/`continue`/`restart`) o orçamento de tempo próprio de cada gate, padrão 15m — separado do `--timeout` (o orçamento do próprio agente) |
| `--prompt <text>` | o texto da tarefa como um único argumento. Coloque entre aspas; o que está dentro é opaco |
| `--prompt-file <path>` | lê o texto da tarefa de um arquivo — para prompts longos, em vez de aspas de shell |
| `--stdin` | lê o texto da tarefa do stdin. Exatamente uma fonte de tarefa por chamada: `--prompt`, `--prompt-file`, ou `--stdin` |

Essa tabela, junto com a tabela de personas acima, é toda a superfície pública. Não existe flag para o estilo de execução — veja a tabela de modos acima.

**Escopo das flags.** Toda flag acima só é válida nos subcomandos que de fato a leem; passá-la em outro lugar é rejeitado antes de o agy sequer ser invocado, com um erro nomeando a flag, o subcomando, e onde ela é válida (a linha do `--worker` acima mostra o padrão). Dois escopos que vale destacar por serem mais estreitos que "toda run command":
- `restart` só lê `--worker` e `--timeout` da própria invocação — ele reproduz o modelo, perfil e tarefa originais do job armazenado, então `--model`/`--effort`/`--restricted`/`--unrestricted`/`--conversation`/`--job` são rejeitados ali. `--prompt`/`--prompt-file`/`--stdin` são a única exceção: aceitos por compatibilidade retroativa, mas ignorados, já que `restart` sempre reconstrói o prompt a partir do spec armazenado.
- `--continue` (a flag booleana) é rejeitada no próprio subcomando `continue` — `continue` já resolveu qual conversa retomar antes de essa flag ser consultada, então ela só faz alguma coisa em um comando de execução direto (`research --continue`).

## Texto da tarefa

Esta seção é sobre a **CLI do companion**, não sobre como você invoca uma persona. Você digita sua tarefa como texto simples depois do slash command (`/agy:reviewer Review PR #730`); a skill lê isso e compõe a chamada `--prompt` abaixo. Você nunca digita `--prompt` você mesmo.

Todo comando de execução (`staffer`, `research`, `review`, `implement`, `ask`, `continue`) pega sua tarefa de **exatamente uma** de três fontes:

```
ask       --prompt "what does git diff --check verify?"
research  --prompt-file /tmp/task.md
review    --stdin < /tmp/task.md
```

Dar duas ao mesmo tempo é um erro (`task text given more than one way (…) — use exactly one`), e não dar nenhuma também é um erro.

**A garantia de opacidade.** O companion faz o parse do argv do shell uma única vez, exatamente como o shell entregou: ele não faz re-split de nenhum argumento, não interpreta nenhuma aspa, e não inspeciona nenhum byte de um valor de tarefa. Sua tarefa chega ao agy byte a byte — espaços, aspas e quebras de linha inclusos — e texto com cara de flag dentro dela (`--check`, `--json`, `--timeout`, um `--whatever` desconhecido) é conteúdo do prompt, nunca uma opção do companion. O mesmo vale para o conteúdo de `--prompt-file` e `--stdin`.

`--prompt` aceita um valor que começa com `--` quando é uma frase de verdade, ou seja, que contém espaço em branco: `ask --prompt "--check means what?"` funciona. Um valor com cara de flag sem espaço em branco é lido como um valor esquecido e é rejeitado. `--` em si não carrega nenhum significado especial; ele é interpretado como uma flag desconhecida.

Flags de valor (`--conversation`, `--model`, `--effort`, `--timeout`, `--restrict`, `--prompt`, `--prompt-file`) exigem um valor. Um valor ausente, um valor vazio, e — à parte as frases de `--prompt` acima — um valor com cara de flag são todos erros, então `--model ""` é um erro.

Cada flag é o seu próprio argumento. Flags empacotadas em uma única string entre aspas (`review "--restricted Review PR #730"`) são um erro que nomeia o fix em vez de chutar onde as flags terminam e a tarefa começa.

## O review é baseado em prompt

O `review` recebe uma descrição de assunto e reúne as evidências sozinho com as ferramentas que tem (`gh pr view`/`gh pr diff` para PRs, `git diff`/`git log` para refs e a working tree, leitura de arquivos para patches). Não existe flag que entregue a ele um diff pronto; descreva o assunto no prompt em vez disso:

```
review --prompt "Review PR #730"
review --prompt "Review the current working tree"
review --prompt "Review changes against master"
review --prompt "Review the patch at /tmp/change.patch"
```

Uma string de tarefa vazia é um erro — o `review` precisa de um assunto. Se o assunto for ambíguo, o agy é instruído a reportar a ambiguidade em vez de chutar o que você quis dizer.

O template de review em si é um esqueleto neutro (postura de revisor, disciplina de evidência, guardrails). Tudo o que é específico de cada sabor — o menu de coleta de evidências, os eixos de review, a classificação por severidade e o formato de saída para code reviews; o enquadramento de desafio multiângulo para reviews de plano/decisão — viaja na string da tarefa, composta pela skill `reviewer` a partir de `skills/reviewer/references/{code-review,general-review}.md`.

## Estado e jobs em segundo plano

**Separação de saída.** O stdout carrega o resultado e qualquer aviso de guarda sobre a working tree; a linha de telemetria `[agy-staff]` (modo, perfil, modelo, duração, tokens, id de conversa) vai para o stderr e, para jobs em segundo plano, para `jobs/<id>.log`. A telemetria é metadado para o agente que chamou — ela não faz parte do entregável e não é armazenada em `jobs/<id>.result.md`.

**Resumo de uso.** Quando o próprio resultado do AGY carrega contagens de token/duração/turno, um job terminal persiste elas no registro do job (`usage` — `input_tokens`/`output_tokens`/`thinking_tokens`/`cache_read_tokens`, o que tiver sido reportado —, `duration_seconds`, `num_turns`), e `wait`/`result` renderizam uma linha compacta logo abaixo do cabeçalho entregue `# Job <id> (<mode>, <status>) — AGY worker: ...`, ex.: `Usage: in 1,728,044 · out 12,301 · think 40,112 · cache 1,200,000 · 19m37s · 42 turns`. Partes ausentes são omitidas, e a linha inteira é omitida para um job sem nenhuma telemetria conhecida (registros mais antigos, ou um estado terminal cujo payload nunca a carregou — ex.: um crash antes de qualquer resultado). Os mesmos campos também aparecem no JSON de `status <id>` e no snapshot terminal do `observe` (`usage`, `duration_seconds`, `num_turns`). O `ask` em primeiro plano já imprime sua própria linha de telemetria no stderr e não é afetado.

`staffer`, `research`, `review` e `implement` retornam handles de job estáveis prontamente. Fluxo padrão: preparar o prompt, despachar, esperar pelo resultado final, e então validar conforme necessário. Enquanto roda, não observe proativamente, não leia logs nem inspecione artefatos intermediários, inclusive para atualizações de rotina. Observe o progresso só quando o usuário pedir explicitamente; diagnostique depois de uma falha ou de um resultado que exija intervenção. Cada worker desanexado drena continuamente o `stream-json` do AGY, mesmo sem observadores. Não existe daemon ou scheduler adicional.

- `wait [id] [--timeout <dur>] [--follow] [--until-done]` espera pela conclusão ou pelo próprio timeout de wait. A conclusão entrega o resultado existente; a expiração soft retorna diretamente um snapshot JSON de observação e deixa a execução rodando. Atividade comum de ferramentas não encerra o wait antes da hora. No exit 2, chame wait de novo para o mesmo job sem checagens de progresso extras; o snapshot retornado não exige intervenção. `--follow` transmite os passos do job para o stderr enquanto espera — útil para um `wait` coletado em um shell em segundo plano, que de outra forma não mostra nada até retornar; o wait continua silencioso por padrão, e o stdout não é afetado de qualquer forma. `--until-done` remove o teto de timeout por completo e bloqueia até o job chegar a um estado terminal; veja abaixo a garantia do exit 2 e quando recorrer a `--until-done`.

#### Wait, exit 2 e `--until-done`

**Exit 2 sempre significa que o job continua vivo e nada foi entregue.** O stdout em uma expiração soft é JSON puro (um snapshot de observação, com `"status":"running"` entre os campos) — quem faz `JSON.parse(stdout)` recebe exatamente isso, sem alteração, em toda chamada de wait, expire ou entregue. Por causa disso, o wait também escreve uma linha **só no stderr** em uma expiração soft: `STILL RUNNING — job <id>, <n>s elapsed. Exit 2: not delivered; call wait again.` (`<n>` são os segundos inteiros desde que o job começou). Ela nunca aparece para um job terminal, e `observe`/`status` também nunca a imprimem — só o caminho de expiração soft do próprio `wait`, já que só o `wait` enquadra um job em execução como "você precisa chamar de novo".

Essa linha existe porque o stdout sozinho não é um sinal seguro: um orquestrador real fez pipe de `wait ... | tail`, o código de saída se perdeu no pipeline, e o JSON puro no stdout foi lido como um resultado entregue. **Nunca faça pipe do `wait` sem capturar o exit code** — `wait ... | tail` (ou qualquer pipe) perde o código sob o comportamento padrão de `pipefail` desligado do shell; use `set -o pipefail` e confira `${PIPESTATUS[0]}` (bash) ou equivalente, ou evite fazer pipe da saída do wait e leia a captura de arquivo/variável em vez disso.

`--until-done` é a alternativa a rearmar você mesmo um `--timeout` finito: ele bloqueia sem teto, fazendo polling na mesma cadência que um wait comum usa, e ainda detecta um worker morto exatamente como o wait já faz (um pid ausente sem resultado armazenado termina o wait como `crashed`, nunca trava indefinidamente). Onde usá-lo depende do host:
- **Hosts com notificação de job em segundo plano (o `run_in_background` do Claude Code)** — lance `wait <id> --until-done` como comando em segundo plano e deixe a própria notificação de conclusão do host acordar a sessão; nada precisa fazer polling ou rearmar.
- **Hosts sem isso (Codex)** — uma chamada `--until-done` em primeiro plano prenderia a sessão inteira sem forma de interromper ou reconferir; mantenha o padrão existente: `wait --timeout 10m`, e rearme (chame de novo) a cada exit 2.
- `observe [id]` sempre retorna JSON limitado (no máximo 8 KiB): progresso atual enquanto roda; status terminal, caminho/disponibilidade do resultado e instruções de coleta quando termina. Estados de erro/cancelado/crash incluem metadados limitados de diagnóstico e recuperação, nunca o relatório completo. Ele lê o estado do job de forma independente de qualquer wait, sem resetar prazos nem consumir o histórico de outro observador.
- `status [id]` lista jobs ou mostra o estado e uma cauda limitada do log de diagnóstico. `result [id]` reimprime a saída armazenada.
- `cancel <id>` pede o cancelamento e retorna sucesso depois que o worker armazena seu relatório e publica `canceled`. Ele preserva diagnósticos de crash e nunca sinaliza um PID armazenado não verificado. Jobs legados sem um canal de cancelamento falham explicitamente. Um erro de cancelamento exige checar o job e os logs; ele não comprova que a execução parou. Interromper um wait não cancela o worker.
- `continue --job <id> --prompt "..."` retoma a conversa conhecida com seu modo/modelo/perfil originais e um novo job vinculado. `continue --conversation <id>` também resolve a configuração a partir dessa conversa conhecida, nunca de um último modo não relacionado. Se o job resolvido terminou em `quota_exhausted` e a nova execução reaproveitaria o mesmo modelo, `continue` imprime um aviso no stderr antes de despachar — ele nunca bloqueia — nomeando o job, o modelo e (quando conhecida) a janela de reset; veja abaixo.
- `restart <id>` relança explicitamente a tarefa/configuração original sem uma conversa, vinculado ao job original. Inspecione mudanças parciais do workspace com `git status` e `git diff` antes de qualquer uma das duas ações de recuperação. Novas execuções regeneram o contexto do workspace. Specs legados rotulam snapshots históricos e anexam o contexto atual. `restart` não tem `--model` próprio, então sempre reaproveita o modelo do job original; ele recebe o mesmo aviso de janela de quota que o `continue` quando aquele job terminou em `quota_exhausted`.

Continuação/restart podem ser invocados de qualquer diretório dentro da mesma worktree e executam no cwd original. O `continue` genérico rejeita ids de conversa não registrados sem lançar o AGY nem procurar em outras worktrees. Continuar uma conversa cujo job ainda está rodando (`continue` genérico, ou o `--continue`/`--conversation` de um modo) é recusado com exit 1 e o ID e status do job; o follow-up não é enfileirado, e quem chamou espera ou cancela primeiro. Para continuação, flags explícitas de modelo/perfil sobrescrevem os valores gravados; caso contrário, esses valores são herdados. Um novo orçamento de recuperação tem padrão de 60m salvo se sobrescrito.

Exit codes para wait/observe/status-com-id: **0** done, **2** running, **3** error/crashed, **4** canceled, **5** attention (timeout retomável, `implement_no_changes`, `implement_uncommitted`, `verification_incomplete`, ou `gate_failed` — veja abaixo), **6** quota_exhausted (veja abaixo), **1** erro de comando. `result` também sai com 5 para attention; seu comportamento legado de exit code para os outros estados — incluindo `quota_exhausted` — não muda: `result` sai com **0** para todo status terminal que não seja attention, então ele nunca inventa um 6. Exit 0 do observe significa que o job terminou, não que o relatório foi entregue. Colete uma sessão de wait já pendente; caso contrário, chame result. Wait/result mantêm seu contrato de resultado completo já existente. Um status `done` significa que a invocação e a entrega da resposta terminaram, não que a tarefa foi aceita. Chamadas bem-sucedidas com avisos incluem uma cauda de log de 8 KiB no stderr e o caminho do log completo; o status nativo e o exit code ficam registrados nesse log. O orquestrador avalia a conclusão e inspeciona mais a fundo só quando necessário. Erros intermediários de ferramentas são retidos internamente e não são promovidos automaticamente a avisos em uma entrega bem-sucedida. Um snapshot em execução contém timestamps, tempo decorrido, as últimas cinco atividades de ferramenta com trechos de entrada/saída e o texto de resposta mais recente, mesclado por passo. Estados desconhecidos, texto incompleto e truncamento são rotulados; uma ferramenta terminar não é prova de progresso útil. Os orçamentos de JSON em UTF-8 são 1 KiB por atividade, 2 KiB para texto e 8 KiB no total. Para uma resposta de progresso pedida pelo usuário, ou diagnóstico depois de falha/intervenção exigida, leia trechos limitados de `details` só se a informação já retornada for insuficiente.

**Esgotamento de quota (`quota_exhausted`, exit 6).** Um 429 vindo do próprio AGY (`RESOURCE_EXHAUSTED`, `code 429`/`429`, `quota exceeded`, `Individual quota reached`, ou `rate limit` no próprio campo de status/erro do AGY — nunca uma menção a essas palavras no corpo da resposta, então uma tarefa que só discute um 429 no bug report de outra pessoa não é classificada errado) termina o job em `quota_exhausted` em vez de `error`, e persiste `model` e `resets_in` — a duração literal que o AGY imprimiu depois de "Resets in" (ex.: `4h1m13s`), nunca uma data calculada, e omitido em vez de inventado quando o AGY não reportou uma. Um 429 em nível de ferramenta do qual o agente já se recuperou (status final `SUCCESS`) continua `done`; timeouts, erros de rede, 401/403, um id de modelo inválido, e um resultado ausente/não interpretável mantêm seus próprios motivos existentes — nunca `quota_exhausted`. O relatório — `result.md`, e o que `wait`/`result` imprimem — começa com `Quota exhausted: model <model>, resets in <resets_in>.` (ou `(reset time not reported)` quando desconhecido), seguido por uma linha de recuperação: trocar para outro worker ou modelo com folga (`workers`) ou esperar o reset — **nunca** dar `continue` no mesmo modelo antes disso. `resets_in` e a mesma orientação de recuperação aparecem em `diagnosticPacket`, no snapshot terminal do `observe`, no JSON de `status <id>`, no `wait`, e no `result`. Os exit codes seguem a convenção já existente de cada comando (`wait`/`status <id>`/`observe`: 6; `ask` síncrono: 6; `result`: 0, igual a todo outro status terminal que não seja attention). Registros de job escritos antes de esse status existir simplesmente não têm o campo `resets_in` e renderizam normalmente.

**Continuando dentro de uma janela de quota.** `continue --job <id>` (ou um `continue` sem argumento/com `--conversation` que resolva para o mesmo job) e `restart <id>` verificam, antes de despachar, se o job que estão retomando terminou em `quota_exhausted` no mesmo modelo que a nova execução vai usar. Se sim, eles imprimem uma linha no stderr — `agy-staff warning: job <id> ended quota_exhausted on model <model> (resets in <resets_in> from <finished time>); continuing on the same model will likely fail again — pass --model <other> or choose another worker (see workers).` — e despacham mesmo assim; isso nunca bloqueia a chamada. Quando a janela de reset pode ser calculada (um `resets_in` interpretável e um `finished_at`) e claramente já passou, não há aviso. Quando ela não pode ser calculada (`resets_in` ausente ou não interpretável, ou nenhum `finished_at`), o aviso ainda dispara, só sem a cláusula `(resets in ...)` — o mesmo modelo logo depois de uma falha de quota já é motivo suficiente. Um `--model` explícito diferente do modelo do job silencia isso (`restart` não tem `--model` próprio, então sempre reaproveita o modelo do job e sempre recebe a verificação). Qualquer status que não seja `quota_exhausted` fica em silêncio.

**Verificação pendente (`verification_incomplete`, exit 5).** Uma execução que reporta SUCCESS enquanto o próprio texto ainda admite que uma verificação está em andamento — "I have started `pnpm build` and am awaiting its completion", "waiting for the tests to finish", "the build is still running", PT "aguardando a conclusão do build", "à espera do build" — termina em `attention` em vez de `done`: um build quebrado já foi para produção assim uma vez, a partir de uma frase que era a *primeira* linha do relatório, então a verificação varre a resposta inteira (limitada a ~64 KiB; um relatório mais longo é varrido em janelas de início e fim), não só a cauda. Os padrões são conservadores e amarrados a texto de verificação/build/test/processo em segundo plano em inglês e português (pt-BR e pt-PT) — um "waiting" genérico em prosa não relacionada (uma decisão de design, "à espera de aprovação", um dev server deixado rodando) nunca aciona isso. Uma menção de pendência seguida mais adiante no mesmo relatório por evidência explícita de conclusão ("build passed", "tests passed", "✓ Compiled successfully", "concluído com sucesso", "o build passou", …) é limpa e o job continua `done`. Uma menção dentro de um bloco de código ou de uma linha de citação (`> ...`) é tratada como citação, não como a própria afirmação do worker, e é ignorada; nada mais é isento, então narração no passado ainda é sinalizada — o objetivo desta verificação é justamente não deixar passar um relatório com a forma do incidente acima. Ela se aplica aos modos que entregam trabalho — `implement` e `staffer` — independente de `--restricted`/`--unrestricted`, já que a própria alegação é o sinal. `research` e `review` são isentos porque rotineiramente descrevem processos que não são deles, e `ask` não tem ferramentas. Precedência: `verification_incomplete` nunca sobrepõe `implement_no_changes`, `implement_uncommitted`, `quota_exhausted`, cancelamento, timeout rígido, ou um erro simples — um no-op de verdade ou um commit não entregue é o problema mais fundamental e mantém seu próprio motivo mesmo quando a resposta também soa como pendente. O relatório é prefixado com `Job needs attention: the worker declared a verification still pending — "<quoted evidence>". Run the pending verification yourself before accepting this work.`, seguido da resposta original completa do worker (informação de diff/conversa preservada exatamente como um job `done` a renderizaria). O registro do job carrega `reason: "verification_incomplete"` e `pending_evidence` (a frase citada), ambos expostos no JSON de `status <id>` e no snapshot terminal do `observe`; a nota de recuperação do `diagnosticPacket` aponta para rodar a verificação pendente, não para tentar de novo.

**Inventário de trabalho parcial (`## Partial work`).** Todo relatório terminal que não seja `done` (`error`, `quota_exhausted`, `canceled`, `attention` por timeout rígido/de resposta, `verification_incomplete`, `implement_uncommitted`, `gate_failed`) anexa uma seção determinística `## Partial work` depois da mensagem e antes do pacote de diagnóstico JSON: estado terminal; `HEAD: <before> → <after> (moved: yes/no)` (ou "unknown (not a git repo)"); caminhos sujos depois da execução (limitados a 50, cada um marcado como `untracked`, `staged`, `new this run`, ou — para um caminho já sujo antes da execução — `status changed` ou `content change not tracked`, já que isso compara status porcelain, não o conteúdo dos arquivos); commits feitos pela execução (`git log --oneline`, limitado a 20) quando o HEAD se moveu; o comando exato de inspeção `git status --short; git diff; git diff --cached` (mais `git log <before>..<after>` quando o HEAD se moveu); uma linha `Verification: not confirmed` (nunca trate esse trabalho como aceito); e uma nota de inventário incompleto sempre que algo estiver faltando (sem git, sem snapshot anterior, HEAD movido para uma árvore limpa de forma que `git diff` não mostra nada, ou uma lista truncada). `verification_incomplete` adicionalmente anota que o agente reportou ter terminado — o único passo não confirmado é a verificação. `implement_no_changes` (um no-op de verdade) não recebe seção: não há nada para inventariar. Um job crashado descoberto depois sem snapshot registrado recebe "Inventory unavailable: worker exited before recording the workspace" mais os comandos de inspeção, nunca dados inventados. A seção é construída a partir dos mesmos snapshots porcelain/HEAD que as guardas de workspace já tiram — sem mecanismo de snapshot separado, e ela nunca copia conteúdo de arquivo ou valores de ambiente.

O worker passa o timeout selecionado para o AGY e aplica de forma independente um limite geral incluindo a inicialização: padrão 60m, configurável até 120m com o `--timeout` do lançamento. Se texto de resposta chegou antes da limpeza por expiração rígida, ele é entregue com um aviso; uma resposta ausente ou vazia precisa de atenção quando uma conversa é conhecida, senão continua como falha. Wait/observe não conseguem renová-lo. Sem uma resposta, a expiração rígida produz `reason=hard_timeout`; um status TIMEOUT explícito ou o `ERROR` exato do AGY mais `timeout waiting for response` produz `reason=response_timeout`. Uma conversa conhecida produz `status=attention` e exit 5; sem uma, o status é `error`. Os relatórios retêm o último snapshot, logs, configuração original e status do workspace antes/depois da execução (o porcelain não detecta mudanças de conteúdo em um arquivo já sujo; inspecione os diffs). Metadados de recuperação incluem `requires_user_confirmation`, `suggested_timeout` (o dobro do timeout anterior, limitado a 120m para jobs em segundo plano) e um comando de continuação exato. No teto, reduza a tarefa. Agentes que chamam devem perguntar se devem continuar ou parar e inspecionar, e só recuperar depois de confirmação explícita do usuário. A recuperação explícita cria um novo job vinculado com um orçamento novo, preservando o registro terminal antigo; o companion nunca tenta de novo automaticamente.

O wait fica em silêncio até a conclusão ou a expiração soft. Só uma pergunta explícita de progresso do usuário justifica observação enquanto roda; mantenha o wait pendente aberto e não transforme a pergunta em checagens recorrentes. A coleta de sessão do host (como o `write_stdin` do Codex) recupera a saída do comando pendente, que pode incluir um snapshot de expiração soft; ela não lê o progresso do AGY de forma independente. Prefira a entrega de conclusão em segundo plano ou um wait bloqueante longo já suportado. Evite polls curtos e vazios, loops de sleep/observe e perguntas de progresso para atualizações de rotina.

Use um wait independente em segundo plano por job onde o harness suportar, nunca serialize múltiplos jobs em um único shell. Caso contrário, use o wait mais longo praticável dentro do limite de chamadas de ferramenta do host. A conclusão encerra um wait pendente, mas o harness externo controla quando o modelo a recebe. Bash + skills não conseguem, de forma universal, acordar um modelo ocioso; uma instrução de timer sozinha não agenda outra invocação.

O estado por repositório mora em `<repo>/.agy-staff/`. `state.json` armazena conversas, histórico de configuração indexado por id de conversa (incluindo o ask em primeiro plano), e registros de ciclo de vida, protegidos por transações de escrita curtas; leituras de observação continuam somente leitura. `config.json` guarda a política de permissão opcional. Cada job tem um spec, um log de diagnóstico, um resultado, um sidecar de status final, stdout bruto (`.events.jsonl`) e um snapshot limitado publicado atomicamente (`.progress.json`). Registros brutos podem incluir eventos desconhecidos/malformados. Arquivos de atividade ausentes em jobs legados produzem um snapshot só com status.

Depois de um sucesso sem avisos, resultados e metadados se tornam duráveis antes que o stream/snapshot bruto seja apagado. Falhas, cancelamento, timeout rígido e resultados com aviso retêm os intermediários. Resultados, logs de diagnóstico, metadados de conversa e o próprio armazenamento de conversa do AGY são retidos. Leitores que competem com a limpeza reconferem o estado terminal: observe retorna metadados terminais; wait retorna o resultado. Observe nunca lê o conteúdo do arquivo de resultado, mesmo depois de intermediários bem-sucedidos terem sido apagados. Relatórios de crash sem resultado incluem evidência de dispatch/início do worker, process ids, existência/tamanho de log e comandos de próxima inspeção/recuperação, sem copiar prompts ou valores de ambiente.

### Mantendo `.agy-staff/` fora do git

Automático desde a 0.4: quando o companion cria `.agy-staff/` pela primeira vez em um repositório, ele anexa `.agy-staff/` ao `.git/info/exclude` (local ao repositório, não versionado), a menos que o caminho já esteja ignorado. Ele nunca toca no `.gitignore` versionado — o diretório de estado é scratch local, e adicioná-lo a um arquivo compartilhado e commitado mudaria o repositório para todo mundo.

## Solução de problemas

- **"agy reported an error (status ERROR)"** — o companion repassa o próprio erro do agy palavra por palavra, e anexa uma dica de causa só quando o texto do erro de fato corresponde a alguma (id de modelo inválido → rode `agy models`; autenticação expirada → rode `agy` interativamente uma vez para relogar). Se o agy reportou um erro mas ainda assim retornou texto de resposta, o companion entrega a resposta mesmo assim — exit 0, resposta no stdout, aviso no stderr (`done_with_warnings`); um prazo sem resposta mas com uma conversa conhecida em vez disso sinaliza attention (exit 5). Uma quota de modelo esgotada é seu próprio estado terminal, não esse caminho genérico — veja [Esgotamento de quota](#estado-e-jobs-em-segundo-plano) acima (`quota_exhausted`, exit 6).
- **`operation not permitted` em `~/.gemini/...` / `bind: operation not permitted` / "authentication failed" repentino enquanto o `agy` funciona no seu terminal** — confira se um sandbox de comando do harness está bloqueando o acesso. O AGY precisa das próprias credenciais OAuth e de uma porta localhost para seu language server interno; permitir só escritas no workspace pode não dar esse acesso. Onde essas restrições valem, use o mecanismo de autorização do host para rodar o companion em um contexto que suporte o AGY. Use o mesmo contexto de permissão para iniciar e gerenciar um job.
- **Falso relatório de crash em `wait`/`status` ("finished with status crashed and no stored result")** — o job em segundo plano foi iniciado em um contexto de permissão ou sandbox (ex.: sem sandbox) e coletado de outro (ex.: dentro de um sandbox de comando). O coletor não consegue ver o PID do worker através da fronteira do sandbox e classifica errado o job em execução como crashed. Rode os comandos de gestão (`wait`, `status`, `result`) no mesmo contexto de permissão sem sandbox em que o job começou; rodar de novo a partir do contexto sem sandbox retoma a espera ou reporta o status normal.
- **Resposta vazia, "status SUCCESS"** — uma execução restricted pode reportar sucesso mesmo quando suas chamadas de ferramenta foram negadas. Confira se o perfil veio de uma flag, de uma política de repositório ou de uma conversa anterior. Use `setup` para configurar comandos permitidos, ou passe `--unrestricted` explicitamente se autorizado; só remover `--restricted` não sobrescreve um perfil herdado. Algumas ferramentas nativas continuam indisponíveis em execuções restricted headless mesmo com regras allow. Uma resposta vazia vinda do modo unrestricted ou do ask sem ferramentas precisa de um diagnóstico separado; retenha os diagnósticos e reporte.
- **"unknown flag --X: the whole string … arrived as a single argument"** — várias flags, e geralmente a tarefa, foram colocadas entre aspas em um único argumento. Cada flag é o seu próprio argumento; a tarefa pertence ao `--prompt`. Veja [Texto da tarefa](#texto-da-tarefa).
- **"task text exceeds the 200KB inline limit"** — o companion, no fim das contas, passa o prompt completo para o AGY como um único argumento de linha de comando. `--prompt-file` e `--stdin` simplificam a entrada, mas não removem esse limite. Encurte o texto da tarefa referindo-se a um PR, branch ou arquivo, e deixe o AGY ler o material sozinho.
- **Anexação do workspace** — chamadas em primeiro e segundo plano passam `--add-dir <repoRoot>` (o diretório de lançamento fora do Git), incluindo continuação e restart. Sem essa anexação explícita, sessões testadas do AGY em modo print podem começar em `~/.gemini/antigravity-cli/scratch` mesmo sem `--sandbox`; o cwd herdado do shell ou configurações de trusted-workspace sozinhas não anexam o repositório. O companion não passa `--sandbox`. A anexação do workspace concede leituras de arquivo com escopo; comandos restricted continuam precisando das próprias regras allow.
- **Workspace sujo no implement** — o `implement` pode começar mesmo quando o repositório já tem mudanças. O companion adiciona ao prompt do agy um resumo de status com limite de tamanho, para que ele saiba que aqueles caminhos são trabalho pré-existente do usuário. Se a tarefa não os inclui claramente, o agy deve perguntar antes de sobrescrever, limpar, dar stash, resetar, apagar, commitar, dar push, ou abrir um PR com essas mudanças.
- **"agy modified the working tree during this review"** — uma execução unrestricted de `research`/`review` mudou arquivos que deveria ter preservado. Inspecione os caminhos listados para identificar mudanças desta execução antes de decidir o que reverter, preservando o trabalho pré-existente do usuário.
- **Permissões de agy com escopo de projeto** — o agy tem regras de nível de projeto ("prioridade máxima") amarradas ao seu sistema de `--project`; o caminho do arquivo de configurações para essas regras não é documentado nem verificado, então o setup só edita o arquivo global. Se uma regra parece ser ignorada, confira no agy interativamente. Veja [Avançado: permissões com escopo de projeto](#avançado-permissões-com-escopo-de-projeto).
- **Contexto de regras** — o agy carrega automaticamente `AGENTS.md`/`GEMINI.md`/`.agents/rules/*.md` do workspace; mantenha esses arquivos sãos nos repositórios onde você delega.

## Migração a partir da 0.1

A 0.2 renomeou os perfis de permissão, mudou para qual perfil os modos apontam por padrão, e removeu as flags que a 0.1 usava para guiar review e execução.

| 0.1 | 0.2 | Notas |
|---|---|---|
| `research`/`review` usam por padrão o perfil estrito (restricted) | `research`/`review`/`implement` usam por padrão `unrestricted` | A 0.1 deixava research e review fail-closed a menos que você rodasse o setup antes. A 0.2 funciona de imediato e faz do `--restricted` a flag de reforço opt-in; o `ask` continua rodando restricted (sem ferramentas). |
| `--strict` | `--restricted` | O nome antigo é aceito como um alias de compatibilidade depreciado; ele avisa no stderr. Mesma semântica. |
| `--loose` | `--unrestricted` | O nome antigo é aceito como um alias de compatibilidade depreciado; ele avisa no stderr. Mesma semântica. |
| nomes de perfil "strict"/"loose" na saída | "restricted"/"unrestricted" | Renomeação cosmética; a linha de telemetria (stderr) agora imprime `profile=restricted` / `profile=unrestricted`. |
| `--diff-file <path>` | *(removida)* | O review é baseado em prompt: `review --prompt "Review the patch at /tmp/change.patch"`. |
| `--pr <num>` | *(removida)* | `review --prompt "Review PR #730"`. |
| `--target <ref>` | *(removida)* | `review --prompt "Review changes against master"`. |
| `--background` / `--wait` | *(removidas)* | O estilo de execução é fixo por modo: `ask` é síncrono, `research`/`review`/`implement` retornam um job id. Gerencie-os com `status`/`result`/`cancel`. |

Flags removidas falham rápido com uma mensagem que nomeia o substituto. Os aliases de perfil depreciados continuam aceitos por compatibilidade; use `--restricted` e `--unrestricted` em comandos e scripts novos.

## Migração a partir da 0.3

A 0.4 consolidou as duas camadas de invocação (comandos + skills) em uma única camada de skills com nomes de persona, adicionou o modo `staffer`, e tornou automática a higiene do `.agy-staff/`.

| 0.3 | 0.4 | Notas |
|---|---|---|
| `/agy:research` (comando) + `/agy:agy-research` (skill) | `/agy:researcher` | uma skill por persona; a camada de comando acabou |
| `/agy:review` + `/agy:agy-review` | `/agy:reviewer` | agora roteia dois sabores: code review e review geral (plano/decisão) |
| `/agy:implement` + `/agy:agy-implement` | `/agy:implementer` | |
| `/agy:ask` + `/agy:agy-ask` | `/agy:ask` | nome inalterado, entrada única |
| *(nenhum)* | `/agy:staffer` | novo modo de uso geral com um prompt mínimo |
| `/agy:status`, `/agy:wait`, `/agy:result`, `/agy:cancel`, `/agy:continue`, `/agy:setup` | a skill `jobs` (voltada para o modelo) | pergunte em linguagem natural ("is the agy job done?"); os subcomandos do companion não mudaram |
| passo manual em `.git/info/exclude` | automático na primeira execução | |

## Migração a partir da 0.4.4 (com quebra de compatibilidade)

A 0.4.5 remove o texto de tarefa posicional. O companion faz o parse do argv do shell uma única vez e nunca faz re-split de um argumento, o que é o que torna seguro o texto com cara de flag dentro de uma tarefa (veja [Texto da tarefa](#texto-da-tarefa)). O preço é que a tarefa precisa chegar por uma fonte explícita.

| 0.4.4 | 0.4.5 | Notas |
|---|---|---|
| `ask "question"`, `review "Review PR #730"` (texto de tarefa posicional) | `ask --prompt "question"`, `review --prompt "Review PR #730"` | O texto posicional foi removido, não depreciado: um argumento posicional em um comando de execução é um erro que nomeia as três fontes. `--prompt-file` e `--stdin` não mudaram. |
| uma string grande só, ex.: `review "--restricted Review PR #730"` | `review --restricted --prompt "Review PR #730"` | O companion não faz mais split de um argumento em flags. Um nome de flag que ainda contém espaço em branco recebe um erro que nomeia esse fix. |

Comandos de gestão (`status`, `wait`, `result`, `cancel`, `setup`) continuam intocados: seus argumentos posicionais são ids e valores, e `wait <id> --timeout 30s` funciona exatamente como antes.

## Migração a partir da 0.4.5

A 0.5.0 atualiza todos os padrões de persona e o alias `flash`/atalho `--effort` do Gemini 3.7 Flash para o Gemini 3.8 Flash, preservando o nível de esforço de cada persona (`ask`: low; `staffer` & `reviewer`: medium; `researcher` & `implementer`: high).

Se o `agy` instalado não suportar o Gemini 3.8 Flash, o companion falha de forma clara, sem fallback silencioso: ele consulta `agy models` e reporta os modelos disponíveis junto com a melhor recomendação compatível de mesmo esforço (ex.: `--model gemini-3.7-flash-high`), recomendando que atualizar o `agy` é preferível para usar o padrão mais recente.

## Suporte a Windows

O Windows é suportado em regime de melhor esforço e exercitado pelo job de CI `Tests (Windows)`; ainda não foi validado contra uma instalação real do `agy` no Windows. Os subprocessos são lançados com `windowsHide: true`, então nenhuma janela de console aparece durante a execução em segundo plano. O cancelamento de job e a limpeza de processo descobrem processos descendentes via PowerShell (`Get-CimInstance Win32_Process`, com `CreationDate` em precisão round-trip) e terminam cada membro identificado individualmente; o líder recorre a `taskkill /PID <pid> /F`, nunca `/T`. Um vínculo de pai só é seguido quando o filho foi criado depois do pai: o Windows mantém o PID de um pai morto em `ParentProcessId`, então, uma vez que esse PID é reaproveitado, um órfão não relacionado (tipicamente o worker desanexado de outro job) pareceria de outra forma um descendente e seria morto. O travamento de estado tenta de novo erros transitórios do Windows (`EPERM`/`EBUSY`/`EACCES`) ao renomear ou remover diretórios de lock e arquivos marcadores.

## Atualizando

O Claude Code e o Codex fazem cache do plugin sob um diretório por **versão** (ex.: `cache/agy-staff/agy/0.4.0`) e decidem "está atualizado?" com base nessa string de versão, não no commit. Suba a versão nos manifestos deles e no `package.json` juntos ao preparar um release. A fonte Git do Pi, em vez disso, segue a ref configurada; fontes locais leem o checkout diretamente.

- **Claude Code** — `claude plugin marketplace update agy-staff` atualiza o clone do marketplace, depois `claude plugin update agy@agy-staff` o recopia para o cache. `install` **não é** o comando de atualização: em um plugin já instalado, ele responde "already installed" e não faz nada, qualquer que seja a versão. E `update` só se move se a string de versão mudou — em uma versão inalterada, ele responde "already at the latest version" e deixa o commit antigo no lugar. Force a entrada do commit atual com `claude plugin uninstall agy@agy-staff && claude plugin install agy@agy-staff`. De qualquer forma, reinicie o Claude Code depois — as skills são registradas no início da sessão.
- **Codex** — suba a versão, rode `codex plugin marketplace upgrade` (ou remova e adicione de novo a entrada do marketplace), depois reinicie o app.
- **Pi** — para uma instalação Git sem pin, rode `pi update --extension git:github.com/naldomadeira/agy-agent-staff`, depois `/reload`. Para desenvolvimento local, regenere as skills do Pi (`npm run generate:pi`) e rode `/reload`; nenhum push é necessário.

Você pode conferir qual commit está de fato instalado: o `gitCommitSha` em `~/.claude/plugins/installed_plugins.json`, contra `git -C ~/.claude/plugins/marketplaces/agy-staff log -1` para o que o clone do marketplace buscou.

## Estrutura do repositório

```
companion/agy-companion.mjs    command entrypoint, modes, job management and setup
companion/stream-worker.mjs    streaming execution, process cleanup and deadlines
companion/observation.mjs      event parsing, progress snapshots and output budgets
companion/state-lock.mjs       state-write locking and stale-lock recovery
templates/                    shared prompt templates (staffer/ask/research/review/implement) and harness-compatibility.md
.claude-plugin/               Claude Code plugin + self-hosting marketplace manifests
.codex-plugin/plugin.json     Codex plugin manifest
.agents/plugins/              Codex marketplace manifest
pi-skills/                    generated agy-* entrypoints/resources for Pi; do not hand-edit
scripts/generate-pi-skills.mjs generates Pi skills and checks for drift
package.json                  Pi manifest, npm file allowlist, and verification commands
skills/                       canonical personas + jobs (Claude/Codex entrypoints;
                              reviewer/ and jobs/ carry references/ for on-demand detail)
assets/                       design diagram + logo + badges
tests/                        offline regression tests and opt-in integration suites
docs/                         references, installation guide and release notes
```
