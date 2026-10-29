# Renor

![Claude Code saves a decision to Renor; a fresh Codex session recalls it](docs/assets/renor-readme-demo.gif)\
*Renor auto-hospedado, em uma sessão real: o Claude Code salva uma decisão e uma nova sessão do Codex a recupera. O tempo de espera foi acelerado.*

[![engine-public-ci](https://github.com/renorai/renor-engine/actions/workflows/engine-public-ci.yml/badge.svg?branch=main)](https://github.com/renorai/renor-engine/actions/workflows/engine-public-ci.yml)

**O Renor é um sistema de memória para agentes de programação: ele mantém o que você informa ao Claude Code, Codex ou Cursor em arquivos Markdown no seu computador e disponibiliza essas informações para qualquer um deles por meio do MCP.**

Toda nova sessão de um agente começa do zero: você precisa explicar novamente o projeto, a decisão tomada na semana passada e seus motivos, ou algo que já precisou corrigir duas vezes. Com o Renor, um agente salva a informação e o próximo a encontra. A memória consiste em arquivos comuns que pertencem a você. O sistema é executado localmente, não exige conta nem chave de API e não envia dados para fora do seu computador, a menos que você configure um modelo ou opte por compartilhar dados. O compartilhamento fica desativado por padrão: o nível `signals` envia métricas anônimas de uso; o nível `data` também envia suas pesquisas e o texto das memórias, com chaves e senhas filtradas. O comando `renor-engine telemetry off` desativa a telemetria. Há também uma versão hospedada, sem necessidade de instalação, em [renor.cloud](https://renor.cloud).

## Início rápido

Você precisa do **Node.js 22** e do Git. A instalação é a única etapa que exige conexão com a internet.

```bash
git clone https://github.com/renorai/renor-engine.git
cd renor-engine
node -v                    # v22.16 ou mais recente
npm ci && npm run build
node scripts/smoke-self-hosted.mjs
```

O último comando inicia o servidor MCP, salva um fato (`Ada favorite_color cerulean`), pesquisa por ele de três maneiras e encerra o servidor. Tudo acontece em uma pasta temporária, excluída ao final, sem tocar nas suas anotações. Ao terminar, o comando exibe:

```text
PASS: self-hosted stdio MCP can remember and retrieve a current fact.
```

Baixou um arquivo ZIP em vez de clonar o repositório? Como ele não contém o histórico do Git necessário para identificar a versão do código usada na compilação, execute o build com `RENOR_BUILD_COMMIT=0000000 npm run build`. Se estiver usando uma versão incorreta do Node.js ou tiver ignorado os scripts de instalação, consulte [Solução de problemas](docs/self-hosting.pt-BR.md#troubleshooting).

## Conecte seu agente

**Sem clonar o repositório.** Com o Node.js 22 instalado, basta executar um comando para registrar o pacote publicado. Suas anotações serão armazenadas em uma pasta oculta chamada `.renor` no seu diretório pessoal (`~/.renor`), cujo caminho é exibido na saída de erro padrão durante a inicialização. O Renor nunca reutiliza uma pasta existente chamada `renor`. Para usar outra pasta, adicione `-e VAULT_PATH=/caminho/absoluto` ao comando do `claude` ou `--env VAULT_PATH=/caminho/absoluto` ao comando do `codex`. A primeira inicialização baixa cerca de 130 MB e leva aproximadamente 15 segundos. Se o agente indicar uma falha de conexão, reinicie-o.

```bash
claude mcp add --scope user renor-local -- npx -y renor-engine mcp
codex mcp add renor-local -- npx -y renor-engine mcp
```

No Cursor ou em qualquer outro cliente, o servidor utiliza o comando `npx` com os argumentos `-y renor-engine mcp`. No Cursor ou no VS Code (GitHub Copilot), é possível adicioná-lo com um único clique:

[![Adicionar ao Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=renor-local&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInJlbm9yLWVuZ2luZSIsIm1jcCJdfQ%3D%3D)

[![Adicionar ao VS Code](https://img.shields.io/badge/VS_Code-Add_renor--local-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=renor-local&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22renor-engine%22%2C%22mcp%22%5D%7D)

Os comandos `claude mcp remove renor-local` e `codex mcp remove renor-local` desfazem os respectivos registros acima. O restante desta seção explica como configurar o Renor a partir de uma cópia clonada do repositório, o que também permite modificar o código.

**A partir de um clone**

Escolha uma pasta para armazenar sua memória. Ela pode ser nova e estar vazia, ou ser um cofre do Obsidian. Em seguida, indexe seu conteúdo. Execute este comando e os comandos seguintes a partir do diretório `renor-engine`, no mesmo terminal:

```bash
export VAULT_PATH="$HOME/renor-notes"    # caminho absoluto; criado se não existir
node dist/cli.js index
```

Cada comando abaixo inicia o Renor usando a versão do Node.js que você está utilizando (`node -p process.execPath`). Assim, o agente não precisa ter o Node.js 22 disponível em seu próprio `PATH`. Se abrir um novo terminal, execute novamente a linha `export` antes de continuar. Caso contrário, o comando será interrompido com a mensagem `VAULT_PATH: run the export line above first`, em vez de registrar um servidor que não consegue iniciar. Para o agente, esse problema aparece apenas como `"Connection closed"`.

**Claude Code**

```bash
claude mcp add --scope user renor-local -e VAULT_PATH="${VAULT_PATH:?run the export line above first}" -- "$(node -p process.execPath)" "$PWD/dist/cli.js" mcp
```

Reinicie o Claude Code. O comando `/mcp` exibirá `renor-local em todos os projetos. Para remover a configuração, execute `claude mcp remove renor-local`.

**Codex**

```bash
codex mcp add renor-local --env VAULT_PATH="${VAULT_PATH:?run the export line above first}" -- "$(node -p process.execPath)" "$PWD/dist/cli.js" mcp
```

Reinicie o Codex. O comando `codex mcp list` exibirá o servidor. Para removê-lo, execute `codex mcp remove renor-local`.

**Cursor**

O Cursor lê os servidores MCP de `~/.cursor/mcp.json` (para todos os projetos) ou `.cursor/mcp.json` (para um projeto específico). O comando abaixo imprime a configuração:

```bash
VAULT_PATH="${VAULT_PATH:?run the export line above first}" node -e 'console.log(JSON.stringify({ mcpServers: { "renor-local": { command: process.execPath,
  args: [process.cwd() + "/dist/cli.js", "mcp"], env: { VAULT_PATH: process.env.VAULT_PATH } } } }, null, 2))'
```

Adicione o resultado a esse arquivo ou mescle a entrada `renor-local` com a seção `mcpServers` existente. Depois, confirme que `renor-local` está habilitado nas configurações de MCP do Cursor. A pasta `cursor-plugin/` deste repositório contém o plugin do Cursor para o serviço hospedado em renor.cloud, que exige uma conta Renor; ele não se conecta a este mecanismo local.

**Qualquer outro cliente MCP:** o comando é `node dist/cli.js mcp` (stdio), com a variável `VAULT_PATH` definida.

Depois, peça ao agente para se lembrar de alguma informação e faça uma pergunta sobre ela em uma nova sessão. Tudo o que o agente salva fica imediatamente disponível para pesquisa. Um arquivo Markdown adicionado ou editado manualmente passa a ser pesquisável após executar novamente `node dist/cli.js index`.

## Onde cada informação é armazenada

| O quê | Onde |
| --- | --- |
| Suas anotações | Qualquer arquivo Markdown em `$VAULT_PATH`. O Renor lê esses arquivos, que podem ser editados com qualquer ferramenta. |
| O que os agentes salvam | Acrescentado como Markdown na mesma pasta: fatos em `System/Memory Events Ledger.md` e anotações em `Memory/Daily/<data>.md`. |
| Índice de pesquisa | Banco SQLite em `$VAULT_PATH/.semantic-memory/index.db`. É um dado derivado: `node dist/cli.js index` o reconstrói a partir dos arquivos Markdown. |

Tudo o que o Renor armazena fica nessa única pasta. Portanto, você pode fazer backup, sincronizá-la ou movê-la como faria com qualquer outra pasta. Nada sai do seu computador, a menos que você configure uma chave de modelo: `EMBEDDING_PROVIDER=openai` envia o texto das suas anotações à OpenAI para gerar embeddings. Já `RENOR_EVIDENCE_MODE=auto` ou `always`, quando usado com uma chave de modelo de evidências (`RENOR_EVIDENCE_API_KEY` ou uma chave `OLLAMA_*`), faz com que a pesquisa envie ao modelo as anotações encontradas. Essa etapa de evidências fica desativada, a menos que `RENOR_EVIDENCE_MODE` seja configurada; portanto, ter apenas uma chave não envia dados. Consulte todas as configurações e seus valores padrão em [docs/ENVIRONMENT-VARIABLES.md](docs/ENVIRONMENT-VARIABLES.pt-BR.md).

**Pesquisa sem embeddings.** Por padrão, o Renor não utiliza modelos de embeddings, então uma anotação é encontrada pelas palavras exatas. Por exemplo, `blue notebook` encontra "The blue notebook is on the desk", mas `where is my notebook?` não encontra essa mesma anotação. Os fatos salvos podem ser encontrados de qualquer maneira. Para pesquisar por significado, configure `EMBEDDING_PROVIDER=openai` com `OPENAI_API_KEY` ou use `local` para baixar um modelo uma única vez e executá-lo no próprio computador. Em seguida, execute `node dist/cli.js rebuild` para gerar embeddings das anotações existentes. Consulte os [detalhes](docs/self-hosting.pt-BR.md#embeddings).

## Mais informações

- [docs/self-hosting.md](docs/self-hosting.pt-BR.md): solução de problemas, embeddings, servidor HTTP com autenticação OAuth, conexão de agentes por HTTP, listas de ferramentas, nomes dos proprietários, ferramentas multiagente (*hive*, configurando `RENOR_CONNECTION_NAME` para cada agente) e proteção do cofre.
- [skill/SKILL.md](skill/SKILL.md): instruções para orientar seu agente a recuperar e salvar memórias sem precisar receber uma solicitação explícita. A maior parte do documento menciona as ferramentas hospedadas (`get_context`, `remember`); o servidor local `renor-local` utiliza outros nomes (`search`, `remember_fact`, `note`), listados na [seção Stdio](skill/SKILL.md#stdio-renor-engine-mcp).

O Renor é um mecanismo de proprietário único: as anotações de uma pessoa e um conjunto de agentes. Não é um produto multiusuário.

## Contribuição, licença e segurança

Contribuições são bem-vindas. O arquivo [CONTRIBUTING.md](CONTRIBUTING.md) explica a configuração do ambiente, os testes e apresenta boas primeiras issues para quem deseja contribuir. O código próprio do Renor está sob a licença **Apache-2.0** ([LICENSE](LICENSE)). A versão 1.0.0 foi lançada sob a licença AGPL-3.0; a partir da versão 1.1.0, a licença é Apache-2.0. Os arquivos importados do projeto de origem continuam sob a licença ISC ([NOTICE](NOTICE), [UPSTREAM.md](UPSTREAM.md)). Para relatar vulnerabilidades, siga as instruções de [SECURITY.md](SECURITY.md) e faça o relato de forma privada, não em uma issue pública.