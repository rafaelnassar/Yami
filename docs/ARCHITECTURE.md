# Yami — Arquitetura

> Documento de referência para quem mantém o código. Se uma mudança contradiz
> algo aqui, atualize este documento no mesmo PR.

## 1. Visão geral

Yami é um app desktop (Electron) que dá interface ao **gallery-dl** e ao
**yt-dlp**: fila de downloads, biblioteca, preview, bandeja e notificações.

Três processos, cada um com uma responsabilidade:

```
┌──────────────────────────┐  IPC tipado (contextBridge)   ┌───────────────────────────┐
│ Renderer (React)         │ ────────────────────────────▶ │ Main (Electron)           │
│  janela principal / tray │ ◀──────────────────────────── │  janelas, segurança, OS,   │
│  sandbox, sem Node       │     eventos (host, settings)  │  OAuth, updates, mídia     │
└──────────────────────────┘                               └─────────────┬─────────────┘
                                                                         │ MessagePort
                                                                         │ (protocolo tipado)
                                                           ┌─────────────▼─────────────┐
                                                           │ Host (utilityProcess)     │
                                                           │  domínio de downloads,     │
                                                           │  SQLite, ferramentas,      │
                                                           │  cofre de segredos         │
                                                           └─────────────┬─────────────┘
                                                                         │ spawn (sem shell)
                                                           gallery-dl / yt-dlp (processos
                                                           destacados, sobrevivem a crash)
```

- **Renderer**: só UI. Não tem Node, não toca disco nem rede. Fala com o main
  exclusivamente por `window.yami` (`src/shared/contracts/ipc.ts`).
- **Main**: dono das janelas, da segurança do Chromium, das integrações com o SO
  (bandeja, diálogos, notificações, `shell`), do login OAuth, das atualizações
  do app e do protocolo de mídia. Não contém regra de negócio de download.
- **Host**: dono do domínio (downloads, biblioteca, cookies, ferramentas). Roda
  num `utilityProcess` (sem `ELECTRON_RUN_AS_NODE`), o que permite desligar o
  fuse `RunAsNode`.

## 2. Estrutura de pastas

```
src/
  shared/            Código puro compartilhado pelos 3 processos (sem Node/DOM/Electron)
    kernel/          Result, AppError/ErrorCode, ids, async (Mutex, throttle), Clock
    validation/      Validação de schema com inferência de tipos (usada em toda fronteira)
    domain/          Tipos/funções de domínio compartilhados (engine, mídia, url)
    contracts/       Contratos entre processos: DTOs, protocolo do host, API IPC, settings
    i18n/            Catálogo pt/en/es + tradutor (todo texto visível vem daqui)
  host/
    domain/          Entidades e regras puras (Download, Batch, políticas, máquina de estados)
    application/     Casos de uso + serviços de aplicação + ports (interfaces)
      ports/         Contratos que a infraestrutura implementa
    infrastructure/  Adaptadores: SQLite, processos, engines, fs, cofre, ferramentas, logs
    interface/       Roteador de comandos, transporte (MessagePort), throttling de eventos
    bootstrap/       Composition root (injeção de dependências) + entrypoint do processo
  main/
    app/             Ciclo de vida, instância única, crash handling, encerramento
    security/        Protocolo app://, política de navegação, permissões, CSP
    windows/         Fábricas de janelas (principal, bandeja) com webPreferences seguras
    host-client/     Cliente do utilityProcess (requests, timeouts, restart com backoff)
    ipc/             Roteador IPC com validação de remetente e de payload + controllers
    features/        accounts (Pixiv), updates, notifications, tray, clipboard, media, dialogs, shell
    infrastructure/  settings store, caminhos, logger, chave do cofre, migração legada
    bootstrap/       Composition root do main
  preload/           Ponte `window.yami` (sem lógica; só mapeia chamadas para canais)
  renderer/
    app/             Shell, providers, ErrorBoundary, pilha de modais
    features/        downloads, library, preview, settings, runtime, tray, notices, logs
    shared/          ui (componentes), hooks, api (cliente de window.yami), lib
```

## 3. Regra de dependência

As setas indicam "pode importar". Qualquer outra direção é proibida e **quebra o
build** (`tests/architecture.test.ts`).

```
host/bootstrap ─▶ host/interface ─▶ host/application ─▶ host/domain ─▶ shared
        └──────▶ host/infrastructure ─┘ (implementa ports)
main/*    ─▶ shared          preload ─▶ shared, electron          renderer ─▶ shared
```

- `shared/**`, `host/domain/**`, `host/application/**`: **nenhum** módulo externo
  (nem `node:*`). São testáveis sem I/O.
- `host/domain/**` só importa `shared/domain` e `shared/kernel` (nunca
  `shared/contracts` / i18n / validation). Tipos de ciclo de vida (`DownloadStatus`,
  `OutcomeKind`, `Folder`, `ToolStatus`, …) vivem em `shared/domain/`;
  `shared/contracts/dto.ts` só reexporta aliases IPC.
- `host/application/**` pode `import type` de DTOs/protocolo na borda CQRS, mas
  **não** importa valores de `shared/contracts/dto` (predicados/constantes vêm de
  `shared/domain`). O protocolo do host está fatiado em
  `host-command-schemas|commands|specs` + `host-events` (barrel em `host-protocol.ts`).
- `host/infrastructure/**` pode usar `node:*`; não importa `interface`/`bootstrap`.
- Main, preload, host e renderer nunca importam uns aos outros — só `shared`.

## 4. Contextos do host (DDD)

| Contexto             | Responsabilidade                                                          | Agregados / serviços                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Downloads** (core) | Fila, agendamento por peso, execução, supervisão, retentativas, conclusão | `Download` (id = conversa), `Batch` (membros + progresso), `SlotBudget`, `OutcomePolicy`, `CookieRetryPolicy`, `DownloadCoordinator` |
| **Library**          | Arquivos baixados, pastas da sidebar, biblioteca em disco                 | `Folder` (regras puras + entidade), consultas de conversa, `LibraryService`                                                          |
| **Engines**          | Como invocar cada engine e interpretar a saída                            | `EngineAdapter` (gallery-dl, yt-dlp), `LineParser`                                                                                   |
| **Runtime tools**    | Detectar, instalar, verificar (SHA-256) e atualizar ferramentas           | `RuntimeService`, manifesto fixado                                                                                                   |
| **Credentials**      | Cookies e contas, criptografados em repouso                               | `CookieVault`, `CredentialVault`                                                                                                     |

Comandos alteram estado através de entidades + repositórios; leituras usam
_query ports_ que devolvem DTOs direto do SQLite (CQRS leve).

## 5. Contratos entre processos

- **Protocolo do host** — `src/shared/contracts/host-protocol.ts`. Cada comando
  declara schema do payload, tipo da resposta, timeout e se é `renderer` ou
  `main-only`. O main valida tudo que vem do renderer; o host valida de novo
  (defesa em profundidade).
- **API do renderer** — `src/shared/contracts/ipc.ts` (`YamiApi`). Toda chamada
  devolve `IpcResult<T>`; erros viajam como `{ code, params }`.
- **Erros** — `ErrorCode` em `src/shared/kernel/errors.ts`. Nunca se envia texto
  pronto ao usuário: a UI traduz `errors.<CODE>` com os `params`.
- **Eventos** — `HostEvent`. O estado (`state`) é limitado a 4/s; logs e arquivos
  saem em lote.

## 6. Convenções de código

- TypeScript estrito em tudo, **apenas sintaxe apagável** (`erasableSyntaxOnly`):
  sem `enum`, `namespace` ou _parameter properties_. Isso permite rodar testes
  direto no Node (type stripping) sem etapa de build.
- Imports relativos com extensão explícita (`./x.ts`) fora do renderer.
- Falhas esperadas retornam `Result<T, AppErrorData>`; exceções são para bugs e
  são capturadas nas fronteiras (roteador IPC / roteador do host).
- Nada de `any`, `@ts-ignore` ou `as unknown as` fora de adaptadores de I/O
  documentados.
- Validar dados na entrada de cada fronteira (IPC, protocolo, disco) com `v.*`.
- Host: nenhuma chamada `*Sync` de `child_process` em caminho quente; I/O de
  arquivos pequeno síncrono só em inicialização.
- Arquivos pequenos e coesos (guia: até ~300 linhas; componentes React até ~250).
- Nomes: `kebab-case.ts` para módulos, `PascalCase.tsx` para componentes,
  `*.test.ts` ao lado do código testado.
- Logs: `Logger` estruturado; URLs perdem query string; tokens e caminhos de
  cookies são redigidos.
- Texto visível: só via i18n (`src/shared/i18n/messages/*`). Cada namespace tem
  um dono (ver cabeçalho do arquivo).

## 7. Segurança (resumo)

| Tema         | Decisão                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer     | `sandbox`, `contextIsolation`, sem `nodeIntegration`, CSP estrita, servido por `app://yami` (não `file://`)                                                                                                                                                                                                                                                                                                                                                                                                |
| Navegação    | Só a origem do app; `window.open` negado; links http(s) vão ao navegador do SO; arrastar arquivo para a janela é bloqueado                                                                                                                                                                                                                                                                                                                                                                                 |
| IPC          | Remetente validado pela URL do frame; payload validado por schema; lista fechada de comandos                                                                                                                                                                                                                                                                                                                                                                                                               |
| Permissões   | Negadas por padrão (câmera, microfone, notificações web, etc.) em todas as sessões                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Segredos     | Cookies e token do Pixiv criptografados (AES-256-GCM); chave protegida por `safeStorage` (DPAPI/Keychain); arquivos de segredo privados (0600 em pasta 0700 no macOS/Linux; no Windows, protegidos pela ACL do perfil do usuário, sem seguir links/junctions) com cookies e config do engine, apagados ao fim de cada execução — pausa e saída do app incluídas; token nunca vai na linha de comando; no Linux sem chaveiro (`basic_text`) a chave fica só ofuscada e `AppInfo.secretsProtected` é `false` |
| Arquivos     | Toda operação passa pelo `PathSandbox` (realpath, dentro da pasta de downloads, fora de pastas protegidas); abrir arquivo segue política de risco com confirmação nativa                                                                                                                                                                                                                                                                                                                                   |
| Ferramentas  | Versões fixadas + SHA-256 no manifesto embutido; download só por HTTPS; extração protegida contra zip-slip; modo Python instala só as wheels do lock de hashes da plataforma (`--require-hashes --no-deps`, versão sempre a do manifesto); o PATH das engines contém só pastas confiáveis (mesma política da detecção) e o yt-dlp só usa o Deno/ffmpeg resolvidos                                                                                                                                          |
| Distribuição | Assinatura de código, auto-update (GitHub Releases), fuses (`RunAsNode` off, integridade do asar, etc.)                                                                                                                                                                                                                                                                                                                                                                                                    |

### Cofre indisponível (modo degradado)

Se o main não consegue carregar `data/vault/key.bin` (`VAULT_UNAVAILABLE` com
`reason` `keystore` — DPAPI invalidado após redefinir a senha do Windows, chaveiro
do Linux perdido ou negado —, `corrupted` ou `io`), o host **não** fica offline:
`system.configure` segue com `vaultKey: null` + `vaultUnavailable` e o host sobe com
um cofre desabilitado (`HostConfigDto.vault = { state: 'disabled', reason }`).

- Downloads, histórico e biblioteca funcionam. Nada em `data/vault/` é lido,
  gravado ou apagado.
- Cookies: a lista vem vazia; enviar/excluir, escolher o cookie padrão e salvar regras
  falham com `VAULT_UNAVAILABLE` (as regras e o cookie padrão salvos ficam intactos,
  mesmo ocultos). A escolha automática (regra por site, cookie padrão) não acha nada
  e o download roda **sem cookies**; um download com arquivo escolhido explicitamente
  fica **pausado** (causa `vault`, timeline `pausedVaultUnavailable`, aviso
  `downloadWaitingVault`) — nunca baixa "em silêncio" sem o cookie pedido e, por não
  ser terminal, mantém o `tmp/` com os arquivos parciais até ser retomado com o cofre
  funcionando (um chaveiro bloqueado costuma ser temporário). Cookies do navegador
  (yt-dlp) continuam valendo.
- Pixiv: sem token (conta aparece desconectada; o download segue sem login);
  conectar/salvar/limpar falha com `VAULT_UNAVAILABLE` — o main recusa antes de
  abrir o OAuth.
- As importações legadas (host e dados de UI do main) são adiadas, sem marcador:
  nada é migrado nem apagado até uma inicialização com cofre funcionando.
- A UI mostra um aviso persistente (toast fixo, volta a cada abertura) e um banner
  em Ajustes › Cookies com **Redefinir cofre** (`vault:reset`). Com o cofre do host
  já funcionando nada acontece (`recovered`, sem reiniciar). Senão o main tenta a
  chave de novo (se carregar, só reinicia o host); senão pede confirmação nativa,
  para o host (`lifecycle.shutdown` `pause`: downloads em andamento voltam à fila e o
  próximo host os retoma), **espera o processo antigo sair** (≤ 5 s; se não sair, nada
  é movido), renomeia `data/vault/` (com `key.bin`) para
  `data/vault.broken-<timestamp>/` — nunca apaga —, cria uma chave nova e sobe o host
  com um cofre vazio (`reset`; `reset-pending` se o reset foi feito mas o host novo
  ainda não ficou pronto). Fechar o app durante o reinício ainda pausa os engines. O
  `key.bin` é gravado com fsync do arquivo e da pasta.

## 8. Dados em disco

| Local                               | Conteúdo                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `userData` (`%APPDATA%\Yami`)       | `settings.json` (main), `data/yami.db`, `data/jobs/*.log` (compactado a ~1 MiB quando o download termina), `data/vault/*` (criptografado), `data/work/<id>/` (temporário: segredos apagados a cada execução; `tmp/` com os `.part` mantido enquanto o download pode continuar) |
| `%LOCALAPPDATA%\Yami\runtime` (Win) | Ferramentas gerenciadas (`bin/`, `python/`)                                                                                                                                                                                                                                    |
| `logs` do app                       | `main.log`, `host.log` (rotativos, redigidos)                                                                                                                                                                                                                                  |
| `userData/data` (outros)            | `legacy-import.json` (marca da importação da 1.x, além da marca no banco), `yami.db.corrupt-<ts>` (banco corrompido posto de lado; as linhas legíveis são copiadas para o banco novo), `vault.broken-<ts>/` (cofre posto de lado por **Redefinir cofre**)                      |
| `~/.yami` (legado)                  | Importado na primeira execução (repetido até 3 vezes se o histórico falhar). Banco e `state.json` nunca são alterados; cookies em texto puro e `credentials.json` são **apagados** depois de criptografados e conferidos no cofre (com aviso na UI)                            |

## 9. Testes

- `npm test` roda todos os `*.test.ts` com o runner nativo do Node.
- Domínio e aplicação são testados com _fakes_ dos ports (sem I/O).
- Infraestrutura tem testes de integração com diretórios temporários e SQLite real.
- `tests/architecture.test.ts` garante a regra de dependência.

## 10. Comandos

| Comando               | O que faz                                                                 |
| --------------------- | ------------------------------------------------------------------------- |
| `npm run dev`         | Vite + bundles em watch + Electron                                        |
| `npm run typecheck`   | TypeScript (node + renderer)                                              |
| `npm run lint`        | ESLint                                                                    |
| `npm test`            | Testes                                                                    |
| `npm run build`       | Bundles (esbuild) + renderer (Vite)                                       |
| `npm run runtime:pin` | Fixa versões e SHA-256 das ferramentas no manifesto (precisa de internet) |
| `npm run dist`        | Gera instaladores (exige manifesto fixado)                                |
| `npm run release`     | Gera e publica no GitHub Releases                                         |
