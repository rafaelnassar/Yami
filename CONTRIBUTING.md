# Contribuindo com o Yami

Obrigado por ajudar! Este guia resume o que é verificado automaticamente e o que esperamos em revisão. A referência
completa de design é [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — se a sua mudança contradiz algo lá, atualize o
documento no mesmo PR.

## Ambiente

- Node.js **≥ 22.18** (os testes rodam TypeScript direto no Node, por _type stripping_).
- `npm ci` e depois `npm run dev` (veja o [README](README.md#primeiros-passos)).
- Editor: o repositório traz `.editorconfig` e `.vscode/` (ESLint + Prettier com formatação ao salvar, TypeScript
  do workspace).

Antes de abrir um PR rode **`npm run check`** (typecheck + lint + testes) e `npm run check:secrets`. Se mexeu em
build/empacotamento, rode também `npm run build`.

## O que nunca commitamos

- Cookies, pastas `downloads/`, dumps de `native-host/`, logs locais
- Chaves e certificados (`.pem`, `.pfx`, `.p12`, `.key`), `.env`, `credentials.json`
- Binários soltos na raiz (`gallery-dl.exe`, instaladores)
- Relatórios / design gerados por IA (`design-system/`, pastas `.cursor` / `.agents` / `.claude`)

O CI e o release falham se algo disso estiver **tracked** ou se houver chave/credencial na raiz do projeto.

## Camadas

```
host/bootstrap ─▶ host/interface ─▶ host/application ─▶ host/domain ─▶ shared
        └──────▶ host/infrastructure ─┘ (implementa ports)
main/*    ─▶ shared          preload ─▶ shared, electron          renderer ─▶ shared
```

| Pasta                     | Pode usar                                                         | Não pode                                           |
| ------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `src/shared`              | só imports relativos dentro de `shared`                           | `node:*`, `electron`, `react`, qualquer pacote     |
| `src/host/domain`         | `shared`                                                          | `application`, `infrastructure`, `node:*`, pacotes |
| `src/host/application`    | `domain`, `shared` (ports em `application/ports`)                 | `infrastructure`, `interface`, `node:*`, pacotes   |
| `src/host/infrastructure` | `node:*`, `application` (implementa os ports), `domain`, `shared` | `electron`, `react`, `interface`, `bootstrap`      |
| `src/host/interface`      | `application`, `domain`, `shared`                                 | `infrastructure`, `bootstrap`                      |
| `src/host/bootstrap`      | tudo do host (composition root)                                   | `main`, `preload`, `renderer`                      |
| `src/main`                | `electron`, `node:*`, `shared`                                    | `host`, `preload`, `renderer`, `react`             |
| `src/preload`             | `electron`, `shared` (roda em sandbox: sem módulos do Node)       | todo o resto                                       |
| `src/renderer`            | `react` e libs de UI, `shared`                                    | `node:*`, `electron`, `host`, `main`, `preload`    |

Isso é verificado por `tests/architecture.test.ts` (fonte da verdade) e pelo ESLint (`no-restricted-imports`), que
mostra o erro no editor. O único pacote externo que o preload aceita é `electron`, e o build falha se ele importar
módulos do Node.

## Convenções de código

- **TypeScript estrito, só sintaxe apagável**: sem `enum`, `namespace` ou _parameter properties_ (declare campos
  `readonly`/`#private` e atribua no construtor).
- **Imports relativos com extensão** (`./x.ts`) fora do renderer; `import type` para imports só de tipos.
- **Sem `any`, `@ts-ignore`, `@ts-expect-error` ou `as unknown as`** — exceto em adaptadores de I/O documentados.
- **Falhas esperadas** retornam `Result<T, AppErrorData>` com um `ErrorCode` de `src/shared/kernel/errors.ts`;
  exceções são para bugs e são capturadas nas fronteiras.
- **Nenhum texto visível fora do i18n**: mensagens viajam como `code + params` e a UI traduz. Os textos ficam em
  `src/shared/i18n/messages/*` (pt é a fonte; en e es obrigatórios). Cada arquivo tem um dono (ver cabeçalho).
- **Validação na fronteira**: todo dado externo (IPC, protocolo do host, disco, rede) passa por um schema `v.*`.
- **Injeção de dependência** pelo construtor, contra interfaces (ports). Sem singletons nem estado mutável em nível
  de módulo (fora dos composition roots).
- **Módulos pequenos e coesos**: guia de ~300 linhas por arquivo (componentes React ~250), uma responsabilidade cada.
- **Nomes**: `kebab-case.ts` para módulos, `PascalCase.tsx` para componentes, testes `*.test.ts` ao lado do código.
- **Comentários** explicam o _porquê_, em inglês e curtos.
- **Logs** pelo `Logger` estruturado; nunca registre query strings, tokens ou caminhos de cookies.
- **Formatação**: Prettier (`npm run format`); largura 120, aspas simples, ponto e vírgula, sem vírgula final.

## Testes

- `npm test` roda todos os `*.test.ts` (`node:test` + `node:assert/strict`); `npm test -- <trecho do caminho>` filtra.
- **Domínio e aplicação**: só _fakes_ dos ports, sem I/O.
- **Infraestrutura**: diretórios temporários e SQLite reais, sempre limpos no final.
- **Sem rede** em nenhum teste.
- **Código específico de Windows** deve ser testável no Linux: injete `platform` e os executores de comando em vez de
  ler `process.platform` direto.
- Todo bug corrigido ganha um teste que falhava antes da correção.

## Commits

Usamos [Conventional Commits](https://www.conventionalcommits.org/pt-br/):

```
<tipo>(<escopo>): <resumo no imperativo, minúsculo, sem ponto final>

<corpo opcional: o porquê da mudança, quebrado em ~72 colunas>

<rodapé opcional: BREAKING CHANGE: …, Refs #123>
```

- **Tipos**: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build` (build/empacotamento/dependências), `ci`,
  `chore`.
- **Escopos**: `host`, `main`, `preload`, `renderer`, `shared`, `i18n`, `runtime`, `tooling`, `docs`.
- Resumo com até ~72 caracteres, em português ou inglês (seja consistente dentro do PR).
- Um commit = uma mudança lógica que compila e passa nos testes.

Exemplos:

```
fix(host): retomar downloads pausados após reinício do host
feat(renderer): filtro por site na biblioteca
build(tooling): assinar instaladores com Azure Trusted Signing
```

## Pull requests

- Descreva o problema, a solução e como testou (inclua prints para mudanças de UI).
- Atualize o [CHANGELOG.md](CHANGELOG.md) (seção "Não lançado") para mudanças visíveis ao usuário. Releases contínuas
  em `main` sobem o patch sozinhas; para um major/minor intencional, bump em `package.json` no mesmo PR.
- Mudanças de estrutura, contratos entre processos ou segurança: atualize `docs/ARCHITECTURE.md`.
- Mudou versões de ferramentas? Rode `npm run runtime:pin` e inclua o manifesto atualizado.
- Vulnerabilidades não vão em PR/issue público — veja [SECURITY.md](SECURITY.md).
