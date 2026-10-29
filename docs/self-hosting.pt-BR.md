# Hospedando o Renor por conta própria

O [README](../README.md) explica como instalar o Renor, verificar seu funcionamento e conectar um agente. Esta página aborda o restante: solução de problemas, embeddings, servidor HTTP, listas de ferramentas, nomes do proprietário e dos agentes, e como o cofre é protegido.

Execute todos os comandos no diretório que contém o `package.json`. Se você usa o mise, `node` significa `mise exec node@22 -- node` e `npm` significa `mise exec node@22 -- npm`. O comando `renor` corresponde a `node dist/cli.js` até que você o vincule com `npm link`. Execute `node dist/cli.js --help` para ver os subcomandos disponíveis (`index`, `search`, `watch`, `rebuild`, `mcp` etc.).

## Solução de problemas

**Versão incorreta do Node.js.** O Renor precisa do **Node.js 22.16 ou superior** (ele utiliza o SQLite integrado ao Node.js; os arquivos `.nvmrc` e `mise.toml` especificam a versão 22 testada). Em uma versão mais antiga do Node.js, todos os comandos são interrompidos imediatamente com uma mensagem como esta:

```
renor-engine: Renor needs Node 22.16.0 or newer (it uses Node's built-in SQLite); this is Node 20.20.0. Fix: install Node 22 LTS or newer (https://nodejs.org), then run the command again.
```

**Extensão de busca vetorial ausente.** O `sqlite-vec` é instalado como uma dependência opcional pré-compilada para sua plataforma. Uma instalação com `--omit=optional` (ou `optional=false` na configuração do npm) não inclui essa dependência. Nesse caso, todos os comandos são interrompidos com uma mensagem informando que a extensão de busca vetorial (`sqlite-vec`) não foi carregada e indicando como corrigir o problema. Reinstale sem omitir as dependências opcionais. Os scripts de instalação não são necessários: `ignore-scripts=true` pode ser mantido.

**Instalação sem conexão com a internet.** O comando `npm ci` precisa acessar o registro do npm ou utilizar um cache do npm já preenchido. Após a instalação, nenhum comando precisa de conexão com a internet, a menos que você configure um modelo que exija acesso externo.

**O agente informa que o Renor não tem ferramentas ou não consegue iniciá-lo.** O próprio agente executa `node dist/cli.js mcp`, portanto, não deixe outro processo do servidor em execução em um terminal. Registre o servidor usando o caminho absoluto do Node.js indicado no README (`"$(node -p process.execPath)"`), em vez de usar apenas `node`, que pode apontar para outra versão no ambiente do agente. Quando definida, a variável `VAULT_PATH` deve conter um caminho absoluto. Se estiver vazia ou não definida, as notas serão armazenadas em `~/.renor` (uma pasta oculta no diretório pessoal, nunca em uma pasta `renor` já existente). Assim, um servidor registrado a partir de um terminal no qual a variável não foi exportada pode iniciar normalmente, mas usar uma pasta diferente daquela que você escolheu. Ao iniciar com essa configuração padrão, o servidor imprime `Renor memory: <path>` no stderr. Se o agente parecer não se lembrar de nada, verifique essa linha primeiro: ele pode estar usando uma pasta diferente daquela que você indexou. Remova o servidor, execute a linha `export` do README e registre-o novamente.

**Uma nota não é encontrada.** O conteúdo salvo por um agente é indexado assim que é gravado. Uma nota Markdown adicionada ou editada manualmente será encontrada após a próxima execução de `node dist/cli.js index`. Como alternativa, mantenha `node dist/cli.js watch` em execução. O servidor não realiza a indexação ao iniciar. Sem embeddings, a busca corresponde a palavras exatas, conforme explicado abaixo.

**Começar com um índice limpo.** O arquivo `.semantic-memory/index.db` contém dados derivados. O comando `node dist/cli.js rebuild` — ou a exclusão desse arquivo seguida de `node dist/cli.js index` — recria o índice a partir da pasta. Os fatos salvos são reproduzidos a partir de `System/Memory Events Ledger.md`.

## Compilação a partir de um ZIP ou tarball

O comando `npm run build` executa primeiro `scripts/ci/stamp-build.mjs`, que grava `dist/BUILD.json`. A rota `/version` do servidor HTTP informa esse commit. Em uma cópia obtida por meio do Git, o commit é lido diretamente do repositório. Uma cópia sem `.git` — como as obtidas por **Download ZIP** no GitHub, por tarball ou por `git archive` — não tem um commit disponível. Nesse caso, a compilação é interrompida até que `RENOR_BUILD_COMMIT` seja definida com uma revisão hexadecimal de 7 a 40 caracteres. Essa variável afeta apenas os metadados da compilação: o código é compilado e executado da mesma forma. Use a revisão que você baixou, se souber qual é. O valor `0000000` também passa pela validação, e a rota `/version` o exibirá.

```bash
cd renor-engine-*
node -v                    # v22.16 ou superior
export RENOR_BUILD_COMMIT=0000000
npm ci && npm run build
node scripts/smoke-self-hosted.mjs
```

## Embeddings

| `EMBEDDING_PROVIDER` | Comportamento da busca |
|---|---|
| Não definida (padrão) | Nenhum modelo de embeddings é utilizado e nenhum dado sai da sua máquina. Uma nota é encontrada quando a consulta contém as palavras exatas; os fatos salvos são encontrados por assunto e valor. |
| `local` | Baixa um modelo de embeddings (por padrão, `Xenova/multilingual-e5-base`) no primeiro uso e, em seguida, executa-o localmente. Permite buscar por significado. |
| `openai` | Gera embeddings usando a OpenAI. Requer `OPENAI_API_KEY` e envia o texto das suas notas à OpenAI. Permite buscar por significado. |
| `eval-hash` | Alternativa determinística e offline usada nos testes. Não oferece garantias de qualidade. |

Se você alterar o provedor em uma pasta que já contém notas, execute `node dist/cli.js rebuild` para gerar os embeddings novamente. Uma execução simples de `index` ignora notas que não foram alteradas. O arquivo [ENVIRONMENT-VARIABLES.md](ENVIRONMENT-VARIABLES.md) lista todas as configurações e seus valores padrão.

## Verificando uma pasta

O comando `node scripts/smoke-self-hosted.mjs` cria uma pasta temporária e a remove depois. Ele ignora `VAULT_PATH`, portanto, não adiciona conteúdo às suas notas. O teste executa as chamadas MCP `tools/list` e `tools/call` para `remember_fact`, utilizando `{"subject":"Ada","predicate":"favorite_color","object":"cerulean"}`. Em seguida, executa `search` com cada uma destas consultas: `What is Ada's favorite color?`, `Ada favorite color cerulean` e `cerulean`. O processo termina com código diferente de zero se alguma chamada falhar ou se `cerulean` não for encontrado.

Para verificar uma pasta específica, informe seu caminho absoluto:

```bash
node scripts/smoke-self-hosted.mjs "$VAULT_PATH"
```

Nesse caso, o fato de teste permanecerá na memória dessa pasta.

## Servidor HTTP

O servidor HTTP é um segundo processo, com uma pasta própria. Ele disponibiliza as ferramentas do produto por HTTP em `127.0.0.1`, com autenticação OAuth para um único proprietário. É necessário usar macOS, Linux ou WSL2 no Windows. O Windows nativo falha ao iniciar porque o armazenamento de clientes OAuth lê um identificador de usuário POSIX que não existe nesse sistema. O servidor não lê `VAULT_PATH`. A configuração `MVP_EMBEDDING_PROVIDER=none` permite executá-lo sem um modelo de embeddings.

O arquivo de clientes OAuth deve ficar em um diretório com permissões `0700`, pertencente a você e fora do diretório de memória. Uma configuração padrão de `umask` é rejeitada durante a inicialização. O diretório de memória também precisa ser acessível somente pelo proprietário, pois contém suas declarações em texto simples. O servidor cria esse diretório com permissões `0700` e os arquivos com `0600`. Se detectar permissões que permitem leitura por grupo ou outros usuários, ele as restringe e registra o ocorrido em uma linha de log. A inicialização só é recusada quando não é possível garantir essas permissões, por exemplo, porque o diretório pertence a outro usuário.

```bash
export MVP_MEMORY_DIR="$PWD/.smoke/memory"
export MVP_PORT=39471
export MVP_BASE_URL="http://127.0.0.1:${MVP_PORT}"
export MVP_OWNER_EMAIL="owner@example.test"
export MVP_OWNER_PASSWORD="$(openssl rand -base64 18)"  # Para consultar a senha: echo "$MVP_OWNER_PASSWORD"
export MVP_AUTH_STATE_PATH="$PWD/.smoke/auth/clients.json"
export MVP_ALLOWED_CALLBACK_URIS="http://localhost:39472/callback"
export MVP_EMBEDDING_PROVIDER=none

mkdir -p "$MVP_MEMORY_DIR" "$(dirname "$MVP_AUTH_STATE_PATH")"
chmod 0700 "$MVP_MEMORY_DIR" "$(dirname "$MVP_AUTH_STATE_PATH")"

npm run mvp  # node dist/mvp/cli.js
```

A variável `MVP_OWNER_PASSWORD` é a única barreira de proteção para sua memória, portanto, utilize uma senha longa e aleatória. O servidor rejeita valores de exemplo presentes em documentações antigas, senhas muito comuns e qualquer valor com menos de 8 caracteres. Altere `MVP_PORT` se a porta 39471 já estiver ocupada e mantenha `MVP_BASE_URL` configurada com a mesma porta. Durante a inicialização, o servidor exibe o endpoint MCP (`$MVP_BASE_URL/mcp`).

Uma requisição sem token é rejeitada:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$MVP_BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```

O comando retorna `401`. Requisições sem um token válido são rejeitadas antes da leitura do corpo. Assim, um corpo malformado ou muito grande também recebe `401`, da mesma forma que um corpo JSON-RPC válido sem autenticação.

**Limite de sessões.** Com `MVP_MCP_JSON=false`, cada sessão aberta mantém um servidor MCP completo na memória, com aproximadamente 0,3 MB medidos por sessão. A variável `MVP_MCP_MAX_SESSIONS` limita o número de sessões simultâneas (padrão: 100; máximo: 1000). Um valor acima do limite faz a inicialização falhar com uma mensagem que informa o teto permitido. Sessões inativas expiram após o período definido em `MVP_MCP_SESSION_TTL_MS`.

**Movendo o diretório de memória.** Mover ou restaurar o diretório — para outro caminho ou a partir de um backup — é seguro. Na primeira inicialização no novo caminho, o servidor remove as linhas de índice deixadas pelo caminho anterior e indexa novamente a pasta antes de responder. Isso gera novos embeddings para todas as notas. Os arquivos Markdown e o registro de eventos nunca são alterados.

### Conectar o Claude Code por HTTP

O Claude Code registra o redirecionamento `http://localhost:<port>/callback`. O host deve ser `localhost`, não `127.0.0.1`. O exemplo acima permite a porta 39472. O parâmetro `--callback-port` precisa usar essa mesma porta; caso contrário, o registro será recusado.

```bash
claude mcp add --transport http --scope local --callback-port 39472 renor-local-http "$MVP_BASE_URL/mcp"
```

Reinicie o Claude Code, execute `/mcp`, selecione `renor-local-http` e entre com `MVP_OWNER_EMAIL` e `MVP_OWNER_PASSWORD`. Para utilizar outra porta, configure `MVP_ALLOWED_CALLBACK_URIS` como `http://localhost:<essa-porta>/callback`, reinicie `npm run mvp` e informe a mesma porta em `--callback-port`. A correspondência é exata: não são aceitos curingas, e `127.0.0.1` não equivale a `localhost`.

### Conectar o Codex por HTTP

O redirecionamento do Codex utiliza sua própria URI de loopback, diferente daquela do Claude Code. O registro será recusado até que essa URI exata também seja incluída em `MVP_ALLOWED_CALLBACK_URIS`, cujos valores são separados por vírgulas.

Adicione a URI, reinicie `npm run mvp` e execute:

```bash
codex mcp add renor-local-http --url "$MVP_BASE_URL/mcp"
```

Se o navegador não abrir, execute `codex mcp login renor-local-http` no seu próprio terminal e reinicie o Codex. Entre com o e-mail e a senha do proprietário.

## Duas listas diferentes de ferramentas

O servidor de linha de comando disponibiliza oito ferramentas: `search`, `evidence`, `keyword`, `entity`, `remember_fact`, `facts`, `status` e `note`. Ao nomear sua conexão, as cinco ferramentas hive também são adicionadas, conforme explicado abaixo. O servidor HTTP disponibiliza um conjunto diferente, com 24 ferramentas, incluindo `remember`, `get_context` e as cinco ferramentas hive: `whats_new`, `ask_agent`, `list_requests`, `answer_request` e `close_request`. O arquivo [skill/SKILL.md](../skill/SKILL.md) descreve as ferramentas HTTP destinadas a agentes.

## Nomes do proprietário

Por padrão, o Renor não considera nenhum nome como sendo o do proprietário. Para que seu nome e palavras em primeira pessoa — como “eu”, “me” e “meu” — sejam associados aos seus próprios fatos, defina `RENOR_OWNER_NAMES` como uma lista de nomes separados por vírgulas. O primeiro nome será o canônico, e os demais serão seus aliases.

Por exemplo:

```bash
RENOR_OWNER_NAMES="Ada Lovelace,Ada,Ada Byron"
```

Se a variável não estiver definida, o Renor apenas ignora diferenças entre maiúsculas e minúsculas e normaliza a forma Unicode.

## Nomes das conexões hive

As ferramentas hive distinguem os agentes apenas pelo nome da conexão. Esse nome não é um argumento das ferramentas.

- **Servidor de linha de comando:** defina `RENOR_CONNECTION_NAME=<nome do agente>` para `node dist/cli.js mcp` (usando `-e` ou `--env` ao registrar o servidor). Cada processo corresponde a uma conexão. Se o nome não ficar vazio após a renderização — ou seja, não for composto apenas por espaços nem for `unnamed` —, o servidor registra as cinco ferramentas hive com esse nome e `tools/list` retorna 13 ferramentas em vez de oito. O nome é lido somente durante a inicialização: argumentos das ferramentas e alterações posteriores nas variáveis de ambiente não renomeiam a conexão. Se a variável não estiver definida, o servidor mantém as oito ferramentas anteriores, não disponibiliza as ferramentas hive e rejeita chamadas diretas a elas, instruindo você a definir a variável e reconectar.
- **Servidor HTTP:** o nome corresponde ao `client_name` do cliente OAuth. Registre um cliente por agente e autorize-o como proprietário. O servidor recupera esse nome a partir do token bearer. As cinco ferramentas hive rejeitam clientes sem nome.

## Arquivos no seu cofre

Ambos os servidores gravam somente em arquivos regulares dentro do cofre. Links simbólicos, hard links e FIFOs inseridos no cofre — por exemplo, em pastas de notas clonadas, compartilhadas ou sincronizadas — são rejeitados e nunca seguidos. A gravação falha com uma explicação do motivo. A própria pasta do cofre pode ser um link. Novos arquivos são criados com permissões `0600`, e novas pastas, com `0700`.

No Linux, após abrir um arquivo e antes de gravar nele, o servidor também verifica o caminho real informado pelo kernel. A gravação é recusada se o arquivo estiver fora do cofre. Isso impede uma condição de corrida na qual outro processo com permissão de escrita dentro do cofre substitui uma pasta por um link enquanto a gravação está em andamento. Em sistemas sem `/proc`, como macOS e Windows, essa verificação é ignorada. Portanto, a condição de corrida continua possível nesses sistemas. Ela exige um processo que já tenha permissão de escrita dentro do cofre, que também poderia editar suas notas.Uma gravação recusada pode deixar um arquivo vazio fora do cofre, mas nunca deixa conteúdo nesse local.