# Política de segurança

## Versões suportadas

| Versão      | Suporte                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| 2.x (atual) | Correções de segurança                                                                   |
| 1.x         | Sem suporte — atualize para a 2.x (os dados de `~/.yami` são importados automaticamente) |

## Como reportar uma vulnerabilidade

**Não abra issue pública.** Use o reporte privado do GitHub:
[Security → Report a vulnerability](https://github.com/rafaelnassar/Yami/security/advisories/new) no repositório
`rafaelnassar/Yami`. Se o formulário não estiver disponível, peça um canal privado ao mantenedor
([@rafaelnassar](https://github.com/rafaelnassar)) sem incluir detalhes da falha.

Inclua, se possível:

- versão do app e sistema operacional;
- passos para reproduzir (URL de exemplo, ajustes relevantes) e o impacto esperado;
- trechos de `main.log` / `host.log` (já saem com URLs e tokens redigidos — confira antes de enviar).

Tentamos confirmar o recebimento em até 7 dias e combinar com você a data de divulgação depois que a correção
estiver publicada. Pedimos que não divulgue detalhes antes disso.

Falhas no **gallery-dl**, **yt-dlp**, **ffmpeg** ou no **Electron/Chromium** em si devem ser reportadas aos
respectivos projetos; reporte aqui se o Yami as expõe de um jeito que não deveria (ex.: versão vulnerável fixada no
manifesto, argumentos inseguros).

## Modelo de ameaças (resumo)

O Yami processa conteúdo não confiável (páginas e mídia de sites de terceiros, saída das ferramentas de download) e
guarda segredos do usuário (cookies de sessão, token do Pixiv). As defesas principais — detalhes em
[docs/ARCHITECTURE.md §7](docs/ARCHITECTURE.md):

| Ameaça                                                                       | Defesa                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conteúdo remoto ou XSS no renderer ganhando acesso ao sistema                | Renderer com `sandbox`, `contextIsolation`, sem Node, CSP estrita, servido por `app://yami`; a API exposta (`window.yami`) é uma lista fechada de chamadas tipadas.                                                                                                                                                                                                                                                                                                                                                 |
| Renderer comprometido abusando do IPC                                        | O main valida o remetente (URL do frame) e o payload de cada chamada por schema; o host valida de novo. Comandos privilegiados são exclusivos do main.                                                                                                                                                                                                                                                                                                                                                              |
| Navegação para origens externas, pop-ups, arrastar arquivos                  | Só a origem do app carrega; `window.open` negado; links http(s) abrem no navegador do sistema; drop de arquivos bloqueado. Permissões web (câmera, microfone, notificações…) negadas por padrão.                                                                                                                                                                                                                                                                                                                    |
| Leitura/escrita de arquivos fora do lugar (path traversal, links simbólicos) | Toda operação de arquivo passa pelo `PathSandbox` (realpath, contido na pasta de downloads, fora das pastas internas). Abrir arquivos executáveis/arriscados exige confirmação nativa.                                                                                                                                                                                                                                                                                                                              |
| Injeção de comando nas ferramentas                                           | Processos iniciados sem shell, com argumentos em lista; URLs validadas (http/https, tamanho máximo).                                                                                                                                                                                                                                                                                                                                                                                                                |
| Vazamento de segredos                                                        | Cookies e token criptografados em repouso (AES-256-GCM, chave protegida por DPAPI/Keychain via `safeStorage`); arquivos temporários de segredo privados (0600/0700 no macOS/Linux; no Windows, dentro do perfil do usuário, cuja ACL já restringe o acesso, sem seguir links/junctions) apagados ao fim de cada execução; token nunca na linha de comando; logs redigidos. No Linux sem chaveiro (`basic_text`), a chave do cofre fica só ofuscada e o app avisa que os segredos não estão protegidos pelo sistema. |
| Ferramentas adulteradas (supply chain / MITM)                                | Versões fixadas com SHA-256 no manifesto embutido; download só por HTTPS; extração protegida contra zip-slip.                                                                                                                                                                                                                                                                                                                                                                                                       |
| Binário do app adulterado                                                    | Assinatura de código, auto-update com verificação do editor quando assinado, fuses do Electron (sem `RunAsNode`, sem `NODE_OPTIONS`/`--inspect`, integridade do asar, carregamento só do asar).                                                                                                                                                                                                                                                                                                                     |

Fora do escopo: um atacante que já controla a conta do usuário no sistema operacional (pode ler a memória do app e
usar a chave do cofre), e o comportamento dos sites baixados em si.
