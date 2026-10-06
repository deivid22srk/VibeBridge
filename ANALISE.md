# ANÁLISE — Integração VibeBridge ⇄ OpenCode

> Análise técnica produzida antes da implementação, conforme solicitado. Cobre os dois
> projetos, a API usada pela integração e as decisões de design.

## 1. OpenCode (`anomalyco/opencode`)

### 1.1 Identificação

O repositório `anomalyco/opencode` (branch `dev`) é o monorepo TypeScript/Bun do OpenCode
(derivado do projeto SST/OpenCode, versão 1.18.34). É um projeto grande (~700 MB com
histórico), organizado em workspaces Bun:

| Caminho | Papel |
|---|---|
| `packages/opencode` | O binário/CLI principal (servidor, TUI, comandos). Entry: `src/index.ts` |
| `packages/core`, `packages/schema`, `packages/protocol` | Núcleo, schemas v1 e protocolo v2 |
| `packages/sdk/js` (`@opencode-ai/sdk`) | Cliente HTTP gerado (hey-api) |
| `packages/server`, `packages/client` | Servidor/protocolo v2 reutilizável |
| `packages/desktop`, `packages/console`, `packages/web` | Apps Electron, console e site |
| `packages/docs/openapi.json` | **Spec OpenAPI completa do servidor (162 rotas), servida em `GET /doc`** |

- **Stack**: Bun (pinado em `packageManager: "bun@1.3.14"`), TypeScript, Effect v4-beta.
- **Build**: `bun install` na raiz; `bun run dev serve` (ou `cd packages/opencode && bun run ./src/index.ts serve`) sobe o servidor direto do fonte. O binário publicado é gerado por `bun build --compile` (`packages/opencode/script/build.ts`), mas **não é necessário compilá-lo** para uso via fonte.
- **Go não é necessário** — menções a "go" nos commits são da landing page "Console Go" (marketing).
- **Banco**: `bun:sqlite` (embutido no Bun) — sem dependências nativas obrigatórias para o servidor.

### 1.2 Servidor HTTP

- Comando: `opencode serve` — flags (definidas em `packages/opencode/src/cli/network.ts`):
  - `--port` (padrão `0` → tenta **4096**, depois porta livre aleatória)
  - `--hostname` (padrão `127.0.0.1`)
  - `--mdns`, `--mdns-domain`
  - `--cors <origin>` (repetível — origens extras permitidas)
- Há também `opencode web` (mesmo servidor + abre o navegador).
- **CORS já embutido** (`packages/server/src/cors.ts`): por padrão aceita qualquer origem
  `http://localhost:*`, `http://127.0.0.1:*`, `oc://renderer`, Tauri e `*.opencode.ai`.
  Origens extras via `--cors` ou config `server.cors`.
- **Autenticação já embutida** (`packages/opencode/src/server/auth.ts`): se a env
  `OPENCODE_SERVER_PASSWORD` estiver definida, TODAS as rotas exigem
  `Authorization: Basic base64(usuario:senha)` (usuário padrão `opencode`, configurável via
  `OPENCODE_SERVER_USERNAME`); fallback `?auth_token=` para clientes que não conseguem
  definir headers (SSE). Sem a env, o servidor é aberto e o `serve` imprime um aviso.
- **Roteamento de instância**: rotas de instância aceitam `?directory=<caminho absoluto>`
  (ou header `x-opencode-directory`) para escolher em qual projeto/diretório o OpenCode
  opera. Sem o parâmetro, usa o diretório de execução do servidor.
- **Eventos**: `GET /event?directory=...` (SSE por instância) e `GET /global/event`
  (SSE global). Envelope: `event: message` + `data: {"id","type","properties"}`.
  Heartbeat `server.heartbeat` a cada 10s.

### 1.3 API usada pela integração (v1, validada no fonte)

| Método | Rota | Uso |
|---|---|---|
| GET | `/global/health` | Health check → `{healthy, version}` |
| GET | `/session?directory=` | Listar sessões |
| POST | `/session` | Criar sessão `{title?, agent?, model?}` |
| DELETE | `/session/:id` | Apagar sessão |
| GET | `/session/:id/message?limit=` | Histórico → `[{info, parts}]` |
| POST | `/session/:id/message` | Prompt síncrono (corpo: `{parts, model?, agent?}`) |
| POST | `/session/:id/prompt_async` | Prompt assíncrono → 204 (usado pelo painel) |
| POST | `/session/:id/abort` | Interromper execução |
| POST | `/session/:id/command` | Executar comando custom `{command, arguments}` |
| GET | `/config/providers` | Provedores + modelos (`{providers[], default}`) |
| GET | `/agent` | Agentes (`mode`, `hidden`) |
| GET | `/command` | Comandos custom |
| GET | `/mcp` | Status dos servidores MCP |
| GET | `/permission` / POST `/permission/:id/reply` | Pedidos de permissão / responder `{reply: "once"\|"always"\|"reject"}` |
| GET | `/question` / POST `/question/:id/reply` / POST `/question/:id/reject` | Perguntas do agente (`{answers: string[][]}`) |
| GET | `/event?directory=` | SSE: `message.part.updated`, `message.part.delta`, `session.status`, `session.error`, `permission.asked/replied`, `question.asked/replied/rejected`, `session.created/updated/deleted`, `server.connected` |

Formatos-chave validados no fonte:

- `PermissionV1.Request` = `{id (per_...), sessionID, permission, patterns[], metadata, always[], tool?{messageID, callID}}`.
- `QuestionV1.Request` = `{id (que_...), sessionID, questions: [{question, header, options[{label, description}], multiple?, custom?}], tool?}`.
- `ToolState` = `pending{input, raw}` | `running{input, title?, metadata?}` | `completed{input, output, title, metadata}` | `error{input, error}`.
- **Streaming de texto**: `text-start` emite `message.part.updated` (texto vazio); cada
  `text-delta` emite APENAS `message.part.delta` (`{sessionID, messageID, partID, field, delta}`);
  `text-end` emite `message.part.updated` final. Tool parts mudam só via `message.part.updated`.
- Partes de prompt: `{type:"text", text}` e `{type:"file", mime, filename?, url}` (URL pode ser `data:`).

## 2. VibeBridge (`ezkizuna/VibeBridge`)

### 2.1 Identificação

- **Stack**: extensão de navegador Chrome/Edge **MV3** (JavaScript puro, sem bundler, sem
  build) + **bridge Python** local (`bridge.py`, porta 17613) que conduz o VSCode via MCP
  (extensão "VS Code MCP Bridge", porta 3333).
- **Como funciona hoje**: content scripts injetam uma barra (`core/main.js`) em sites de
  chat de IA (DeepSeek, ChatGPT, Gemini, Kimi, GLM, Qwen, Arena, Meta AI). Cada
  `providers/<site>.js` exporta a interface `ZSProvider` (achar caixa de texto, enviar
  mensagem, ler resposta, detectar "gerando"...). O loop agêntico do `main.js` envia um
  system prompt ensinando o modelo a emitir comandos JSON `{"command": ..., "params": ...}`,
  captura esses comandos no texto da resposta (`core/parser.js`), executa via
  `background.js` ⇄ WebSocket ⇄ `bridge.py` ⇄ MCP e devolve o resultado ao chat.
- **Testes**: `test-parser.js` e `test-chatgpt.js` são smoke tests em Node carregando os
  arquivos com `new Function(...)`.

### 2.2 Por que o provedor OpenCode NÃO usa o loop agêntico existente

O loop do VibeBridge existe porque os chats web não têm ferramentas: quem executa
comandos é a extensão/bridge, via JSON colado no texto. O OpenCode é o oposto: ele já tem
ferramentas nativas (ler/criar/editar arquivos, bash, busca, MCP, agentes), sessões,
permissões e streaming. Forçar o modelo do OpenCode a emitir o JSON do VibeBridge criaria
dois agentes brigando pelo mesmo projeto. Portanto o provedor OpenCode:

- **não injeta o system prompt do VibeBridge**;
- **não usa a bridge Python** (o OpenCode executa tudo no próprio workspace dele);
- **é um cliente completo da API do OpenCode**, com a UI da extensão controlando tudo.

### 2.3 Decisão de design: painel como página da extensão

A interface `ZSProvider` pressupõe um DOM de chat web (itens de conversa, caixa de texto
do site, botão enviar...). O OpenCode não tem "site de chat". Opções consideradas:

1. Servir uma página fake de chat pela `bridge.py` e encaixar o provider no loop atual —
   rejeitada: acoplamento frágil, duplicaria a execução de ferramentas.
2. Page da própria extensão (`chrome-extension://<id>/opencode.html`) — **escolhida**:
   - páginas de extensão fazem `fetch` sem restrição de CORS para origens listadas em
     `host_permissions` (já existe `http://127.0.0.1/*`; adicionamos `http://localhost/*`);
   - é literalmente "a interface da extensão" controlando tudo;
   - não exige mudanças na bridge Python nem content scripts.

O "OpenCode" aparece como mais um provedor selecionável: botão próprio no popup da
extensão (ao lado do fluxo VSCode) e status próprio de conexão.

## 3. Plano de implementação

**VibeBridge** (novo): `opencode-api.js` (cliente HTTP/SSE puro, testável em Node),
`opencode-app.js` (UI do painel), `opencode.html`, `opencode.css`,
`test-opencode-api.js`; ajustes em `manifest.json` (host permissions +
`optional_host_permissions` para IPs de rede) e no popup. Paridade de recursos: sessões
(criar/listar/retomar/apagar), prompts com streaming, chips de ferramentas com resultado,
permissões (aprovar sempre/uma vez/negar), perguntas com opções, troca de
modelo/provedor/agente, comandos custom, status MCP, anexo de arquivos, abortar,
reconexão automática com backoff, mensagens de servidor offline e timeouts.

**OpenCode fork** (`opencode-termux`): nenhuma mudança de código foi necessária para a
integração (CORS e auth já atendem); o fork concentra-se em `install-termux.sh`,
`CHANGES.md` e a seção "Instalação no Termux" no README. Detalhes em `CHANGES.md`.

## 4. Riscos e limitações

- Teste ponta a ponta com um modelo real exige chave de API de um provedor configurada no
  OpenCode — aqui o servidor foi validado com health/sessões/SSE/permissões (sem
  inferência). A UI trata erros de inferência via `session.error`.
- `install-termux.sh` foi testado em Linux x64 (Debian); Termux real (Android/bionic) tem
  peculiaridades documentadas no README do fork (Bun para android-aarch64, módulos
  nativos opcionais). O script é idempotente e seguro para rodar mais de uma vez.
