<p align="center"><img src="assets/logo/gemini-agy.svg" width="440" alt="AGY-STAFF"></p>

<p align="center"><a href="README.md">English</a> | <a href="README.pt-BR.md">Português (Brasil)</a></p>

<p align="center"><a href="https://antigravity.google/product/antigravity-cli"><img src="assets/badges/powered-by-antigravity.svg" height="20" alt="powered by: Antigravity"></a> <img src="assets/badges/model-gemini-3-8-flash.svg" height="20" alt="model: Gemini 3.8 Flash"></p>

<p align="center"><a href="https://claude.com/claude-code"><img src="assets/badges/claude-code-plugin.svg" height="20" alt="Claude Code plugin"></a> <a href="https://developers.openai.com/codex/"><img src="assets/badges/codex-plugin.svg" height="20" alt="Codex plugin"></a> <a href="LICENSE"><img src="assets/badges/license-mit.svg" height="20" alt="license: MIT"></a></p>

Contrate a Antigravity CLI (`agy`) do Google como staffer para **Claude Code**, **OpenAI Codex** e **Pi**.

![agy-staff design](assets/design.png)

**[Instalação](#instalação) · [Exemplos](#cujs) · [Design central](#design-central) · [Atualização](#atualização)**

## O que é e por quê

O agy-staff permite que seus agentes sênior deleguem tarefas ao `agy`, que roda o Gemini 3.8 Flash — rápido. Oito skills: staffer (uso geral), researcher, reviewer (code review **e** revisão de planos/decisões), implementer e ask — além de lead (orquestração), pool (worker pool opcional) e uma skill jobs voltada para o modelo. O Claude Code usa `/agy:<persona>` e o Codex usa `$agy:<persona>`.

Se você usa o Codex, conhece a sensação: o GPT-5.6-Sol é lento mesmo com o fast mode ligado. O Claude Code é mais rápido, mas ainda não é rápido, e a quota do Fable é escassa o suficiente para você querer que ele orquestre subagentes em vez de fazer, ele mesmo, cada survey e cada review. Um worker agy te dá uma pista rápida: segunda opinião em segundos, pesquisa e revisão na velocidade do Flash, implementação com escopo definido rodando de lado enquanto você segue em frente. E onde velocidade não é o ponto, ter uma segunda família de modelo olhando para o mesmo código compra cobertura e robustez que seu agente principal não consegue se dar sozinho.

![two overloaded senior agents hand the baton to one fast agy worker](assets/why.png)

## Como funciona

### Invocar uma persona

Digite `/agy:` no Claude Code e as oito skills aparecem na hora:

![the /agy: command menu in Claude Code](assets/claude-code-screenshot.png)

Mesmo plugin no Codex, invocado com `$agy`:

![the $agy skill picker in Codex](assets/codex-desktop-screenshot.png)

### Instalação

#### Para humanos

Passo 1 — instale a Antigravity CLI ([documentação oficial](https://antigravity.google/docs/cli/install)) e depois confirme com `agy --version`. O Node.js também é necessário:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Passo 2 — instale o plugin no seu harness:

```bash
claude plugin marketplace add naldomadeira/agy-agent-staff
claude plugin install agy@agy-staff
```

```bash
codex plugin marketplace add https://github.com/naldomadeira/agy-agent-staff
codex plugin add agy@agy-staff
```

> O marketplace se chama `agy-staff`, enquanto o repositório é `agy-agent-staff` — o id depois do `@` é o nome do marketplace.

<details>
<summary>Usando o Pi?</summary>

Instalar: `pi install git:github.com/naldomadeira/agy-agent-staff`.
As skills têm o prefixo `/skill:agy-<persona>` (ex.: `/skill:agy-ask reply with OK`), com `/skill:agy-jobs` para a gestão de jobs.
Atualizar com `pi update --extension git:github.com/naldomadeira/agy-agent-staff`, depois rodar `/reload`.

</details>

Reinicie o Claude Code ou o Codex depois disso. Primeira execução: `/agy:ask reply with OK` (Claude Code) ou `$agy:ask reply with OK` (Codex). O `ask` não usa ferramentas e não precisa de nenhuma configuração.

> [!IMPORTANT]
> **Não há etapa de configuração obrigatória.** `staffer`, `researcher`, `reviewer` e `implementer` rodam **sem restrição** por padrão: o agy pode inspecionar o repositório, rodar comandos e editar arquivos. O agy-staff mantém isso viável com prompts que se adaptam ao estado atual do repositório. Por exemplo, quando o `implementer` começa em um workspace sujo, o companion avisa ao agy quais arquivos já tinham mudanças e o lembra de não sobrescrever nem entregar como seu trabalho alheio já existente do usuário. Se a tarefa pedir um commit, push ou PR, o agy pode fazer essa entrega; caso contrário, ele deixa um diff na working tree para revisão. Essas instruções de prompt não fornecem isolamento de permissão.
> `setup` + `--restricted` é um **reforço opcional** para entrada não confiável — por execução (`--restricted`) ou como padrão por repositório (`setup --restrict review,research`). O `setup` faz um dry run e pede confirmação antes de escrever qualquer coisa ("configurar o agy" o aciona); leia antes as [notas de permissão](docs/REFERENCE.pt-BR.md#reforço-opcional-setup) — a allowlist usa correspondência por prefixo, vale para a máquina inteira, e uma execução restrita pode retornar menos do que uma sem restrição.

#### Para agentes

Cole isto em qualquer agente de código:

```
Read the raw text of https://raw.githubusercontent.com/naldomadeira/agy-agent-staff/master/docs/INSTALL_FOR_AGENTS.md (curl it — do not
work from a summary) and follow it to install and verify the agy-staff plugin for the harness you are running in.
Respond in the user's language.
```

#### Atualização

O Claude Code e o Codex instalam uma *cópia*, então uma nova versão só chega até você quando você mesmo a busca:

```bash
claude plugin marketplace update agy-staff && claude plugin update agy@agy-staff
```

```bash
codex plugin marketplace upgrade && codex plugin add agy@agy-staff  # depois reinicie o Codex
```

O Claude Code e o Codex fazem cache por diretório de versão, então uma atualização só entra se a versão do plugin mudou; reinicie o harness depois. Se um fix não aparecer, veja [atualizando](docs/REFERENCE.pt-BR.md#atualizando) — lá está o comando de force-refresh.

### CUJs

Os exemplos abaixo usam o `/agy:…` do Claude Code; no Codex use `$agy:…`.

| Caso de uso | Invocação |
|---|---|
| Liderar uma tarefa em andamento | `/agy:lead investigate the options, draft a proposal, and revise it with my feedback` |
| Segunda opinião rápida | `/agy:ask what's your backend model` |
| Uma tarefa geral | `/agy:staffer summarize the open TODOs in this repo` |
| Gerar uma imagem | `/agy:staffer generate a pixel-art robot mascot, save it as assets/mascot.png` |
| Revisar a working tree | `/agy:reviewer Review the current working tree` |
| Revisar um PR | `/agy:reviewer Review PR #730` |
| Revisar um plano ou decisão | `/agy:reviewer Challenge the migration plan in docs/plan.md` |
| Fazer um survey de um tema | `/agy:researcher how does auth work in this repo` |
| Implementar um fix com escopo definido | `/agy:implementer fix the flaky retry test` |
| Inspecionar ou selecionar um worker AGY | `/agy:pool workers` |
| Operações de job (wait/status/cancel/continue) | linguagem natural: "is the agy job done?", "continue: also check the error path" |

O `reviewer` é totalmente baseado em prompt: você descreve o assunto e o agy mesmo reúne as evidências (`gh pr view`, `git diff`, leitura do arquivo) — não existe flag para entregar a ele um diff pronto. Ele tem dois sabores, roteados pelo assunto: code review (achados classificados por severidade) e review geral (um desafio multiângulo de um plano, design ou decisão).

O `staffer` também cobre as ferramentas nativas do agy sem um persona especialista dedicado, incluindo **geração de imagem** (`generate_image`). Um teste no agy v1.1.15 produziu um PNG de 1024×1024 em cerca de 30 segundos; o tempo real depende da tarefa e do ambiente.

## Design central

### Pool de workers opcional

A instalação normal usa um worker: `AGY_BIN || agy`. O pool é opt-in; use `$agy:pool workers` (ou `/agy:pool workers`) para inspecionar os workers e `--worker <id>` para selecionar um. A descoberta verifica `AGY_BIN`, `AGY_POOL_BINS`, os executáveis `agy`, `agy2`, `agy3` no `PATH`, e por fim o `.agy-staff/config.json` opcional. Aliases e funções de shell não são visíveis para o Node; use wrappers executáveis ou caminhos explícitos. Os jobs mantêm afinidade de worker entre `continue` e `restart`. Todo dispatch, entrada de status e observação identifica seu worker AGY externo, o que dá ao Codex e ao Claude Code o mesmo contexto visível mesmo que os painéis de subagente nativos do host não consigam representar processos externos. Trabalho em paralelo é para tarefas independentes; escritas exigem worktrees separadas ou autorização explícita.

O `lead` adiciona orientação de orquestração de tarefas para o seu agente atual. Dentro do lead, oriente-se o suficiente para enquadrar a atribuição, delegue o trabalho substantivo para o `staffer` por padrão, espere o resultado, depois avalie e integre ou faça o follow-up. Os especialistas fornecem orientação dedicada quando útil, enquanto o `ask` fica reservado para testes. O host é dono das decisões entre tarefas, da aceitação, da integração e da entrega, usando o fluxo de jobs já existente. Invoque `/agy:lead` no Claude Code, `$agy:lead` no Codex, ou `/skill:agy-lead` no Pi.

O `ask` responde na mesma chamada. As outras personas retornam um id de job e um comando de coleta: no Claude Code, lance `wait <id> --until-done` como comando em segundo plano e deixe o host te avisar quando ele retornar; no Codex e em outros hosts sem notificações em segundo plano, faça polling com `wait <id> --timeout 10m`, rearmando a cada exit 2 (nunca faça pipe da saída do `wait` — um pipe perde o exit code).

O agente principal espera pelo resultado final por padrão. Se você perguntar explicitamente sobre o progresso, ele pode usar `observe` para ler um snapshot da atividade recente de ferramentas e do texto de resposta; ele não consulta o progresso para atualizações de rotina. Quando a tarefa termina, `wait` ou `result` entrega o relatório completo. Deixar um wait expirar não interrompe o worker, que continua rodando.

A linha do tempo abaixo acompanha uma tarefa em segundo plano da delegação até a conclusão. O agente host espera pelo resultado final por padrão (ou avança em trabalho independente já identificado), verifica o progresso quando solicitado, e coleta o relatório.

[![A background task over time: the host delegates, waits or observes, while the worker continuously saves AGY output and eventually delivers the full report](assets/integration.png)](assets/integration.svg)

Os jobs têm um prazo de execução separado: 60 minutos por padrão, configurável no lançamento com `--timeout` até 120 minutos. Use `cancel` para interromper a execução, ou peça explicitamente `continue` ou `restart` depois de inspecionar o trabalho já feito. O harness do host controla quando seu agente recebe um resultado em segundo plano.

Além de `done`, um job pode terminar em `attention` (exit 5 — um timeout retomável, um no-op/mudança não commitada não entregue, uma verificação que o próprio worker sinalizou como ainda pendente, ou um gate de companion-run que falhou/expirou), `quota_exhausted` (exit 6 — troque de worker/modelo ou espere o reset, nunca dê `continue` no mesmo modelo antes disso), `error`/`crashed`, ou `canceled`. Todo relatório que não seja `done` inclui um inventário `## Partial work` (movimento de HEAD, caminhos sujos, um comando de inspeção) para checar antes de qualquer recuperação.

Briefings de `implementer` nunca devem exigir uma baseline completa de build/test/lint — isso é recusado antes do dispatch (exit 1) para que um worker nunca queime todo o seu tempo de execução no gate em vez da tarefa. Declare `--gate <nomes>` (procurados no mapa `gates` do `.agy-staff/config.json`) ou um `--gate-cmd` ad hoc em vez disso: o companion o executa depois que o worker reporta done, e uma falha termina o job em `attention`/`gate_failed`, enquanto um sucesso transforma até um `verification_incomplete` em `done`.

**Referência completa →** [docs/REFERENCE.pt-BR.md](docs/REFERENCE.pt-BR.md) (flags, modelo de permissão, jobs/estado, troubleshooting, atualização). **Notas de release →** [docs/releases/](docs/releases/).

## Comunidade

- [LINUX DO](https://linux.do/) — Uma comunidade Linux de nova geração.

## Contribuindo

Contribuições são bem-vindas — issues, relatos de bug e pull requests, todos ajudam.

Algumas coisas úteis de saber antes de abrir um PR:

- **Rode os testes**: `npm test`. A suíte padrão usa repositórios e diretórios HOME temporários com um `agy` falso, além de testes de módulo focados. Mantenha os testes de regressão offline e independentes de configurações pessoais. A validação real com o AGY é uma suíte separada e opt-in, descrita em [tests/README.md](tests/README.md).
- **Os docs vêm em pares**: `README.md` / `README.pt-BR.md` e `docs/REFERENCE.md` / `docs/REFERENCE.pt-BR.md` são mantidos em sincronia. Mude um, mude sua contraparte. Os docs em pt-BR mantêm em inglês os identificadores de código, flags, comandos e termos técnicos já consolidados.
- **O código de runtime mora em `companion/`**: o entrypoint cuida dos modos e dos comandos de job; módulos separados cuidam da execução em streaming, das observações e do travamento de estado. As skills chamam o companion, e `templates/` guarda os prompts compartilhados.
- **As skills canônicas são a fonte da verdade**: edite as personas em `skills/`, nunca em `pi-skills/`. Rode `npm run generate:pi` para gerar os entrypoints do Pi, e `npm run check:pi` para verificar a consistência.

Adicionar um modo ou uma flag muda a superfície pública, então por favor abra uma issue primeiro para combinarmos o formato.

## Licença

MIT — veja [LICENSE](LICENSE).
