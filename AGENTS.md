# Regras do repositório agy-agent-staff

Estas regras complementam as instruções do workspace. Valem para mudanças no companion, nas skills, na documentação, nos testes e no empacotamento do plugin.

## Uma mudança, todas as superfícies

1. Antes de editar um fluxo público, localize o comportamento no `companion/`, a orientação canônica em `skills/`, a mensagem que o CLI imprime no momento do uso, os exemplos em `README*.md` e `docs/REFERENCE*.md`, e os testes correspondentes. A mensagem de despacho é parte da interface: o agente a recebe imediatamente e pode segui-la mesmo quando uma skill já foi atualizada.
2. Alinhe as superfícies afetadas no mesmo trabalho. `skills/` é a fonte dos artefatos `pi-skills/`: rode `npm run generate:pi` quando mudar uma skill canônica e confira `npm run check:pi`. Não edite os arquivos gerados diretamente.
3. Para coleta de jobs, mantenha o contrato por host explícito e verificável: Claude Code usa `wait <id> --until-done --follow` em shell de background com stdout e stderr ligados; Codex usa `wait <id> --timeout 10m --follow` e rearma no exit 2. Um pipe ou redirecionamento esconde o progresso ou mascara o código de saída. Se um `wait` antigo já estiver rodando, explique como interromper somente esse `wait` e relançá-lo; isso não cancela o job AGY.
4. Escreva um teste que exercite a saída real do CLI antes de alterar o comportamento. Confirme que ele falha pelo sintoma relatado, depois que passa com a correção. Inclua nos testes de regressão qualquer comando recomendado ao usuário, especialmente o que o despacho imprime.

## Verificação e entrega

- Antes de concluir, execute `npm test`, `npm run check:pi`, `git diff --check` e leia `git diff`. O `package.json` não define scripts de build ou lint; não diga que passaram. Informe falhas ou etapas não executadas com precisão.
- Não faça commit, push, tag ou release sem solicitação do usuário. Use paths específicos ao preparar uma entrega; nunca inclua estado `.agy-staff/`, `.env` ou credenciais.

## Fonte, instalação e sessão ativa

- O checkout do repositório e as instalações do Claude Code e do Codex são cópias distintas. Antes de dizer que uma correção chegou ao usuário, compare a versão do checkout com a instalação ativa: no Claude Code, use `installPath` de `~/.claude/plugins/installed_plugins.json`; no Codex, consulte `codex plugin list`. Não escolha um diretório antigo do cache por glob.
- Edição local entra em vigor no próximo processo que chama **este checkout**. Jobs e shells de `wait` já iniciados mantêm os argumentos com que foram lançados. Cópias instaladas pelo marketplace só recebem o código novo após nova versão publicada, atualização do marketplace/plugin e reinício do host; não edite caches gerenciados manualmente.
- Ao entregar uma mudança, diga separadamente: o que foi alterado no checkout, qual versão está instalada em cada host, o que ainda depende de release/atualização e o que precisa ser relançado na sessão atual.
