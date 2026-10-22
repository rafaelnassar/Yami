# Changelog

Todas as mudanças relevantes do Yami ficam registradas aqui. O formato segue o
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Corrigido

- Downloads do Reddit voltaram a funcionar. O Reddit bloqueia as rotas JSON ("You've been blocked by
  network security.") para qualquer User-Agent de navegador — inclusive o padrão do gallery-dl —, então
  o app passa a enviar um User-Agent de leitor de feed **só** ao extrator do Reddit, sem alterar mais
  nada.
- Vídeos do Reddit voltaram a baixar **com áudio**: o gallery-dl agora usa o manifesto DASH do post (que
  o yt-dlp baixa anonimamente) em vez da URL do post, que o yt-dlp passou a resolver apenas com uma
  conta conectada e que falhava todos os vídeos.

## [2.0.0] - ainda não lançado

Reescrita completa do app sobre uma arquitetura em camadas (Clean Architecture/DDD), mantendo o comportamento da
1.x. Os dados da 1.x (`~/.yami`) são importados automaticamente na primeira execução.

### Adicionado

- Processo **host** em `utilityProcess` com protocolo tipado e validado; reinício automático com _backoff_ e
  retomada dos downloads em andamento se ele cair.
- Importação única dos dados da 1.x: histórico, downloads ativos (como pausados), ajustes, pastas da barra lateral,
  vínculos de cookies, cookies e credenciais do Pixiv. Depois de criptografados, os arquivos de cookies e o
  `credentials.json` antigos em `~/.yami` são **apagados** (o app avisa se algum não pôde ser migrado).
- Arquivos baixados recebem a marca de origem da internet (Mark-of-the-Web no Windows, quarentena no macOS), então
  SmartScreen, Gatekeeper e o Modo Protegido do Office voltam a agir sobre eles.
- Cofre criptografado (AES-256-GCM, chave protegida pelo sistema) para cookies e token do Pixiv.
- Ferramentas (gallery-dl, yt-dlp e dependências) com versões fixadas e verificação SHA-256.
- Interface traduzida para português, inglês e espanhol, incluindo notificações, bandeja e diálogos do sistema.
- Auto-update pelo GitHub Releases, instaladores assinados (quando configurado) e _fuses_ de segurança do Electron.
  A versão portátil não se atualiza sozinha: ela avisa quando há versão nova e abre a página de releases.
- CI no GitHub Actions (Windows e Linux) e workflow de release contínuo em `main` (versão automática para o
  auto-update), com teste de abertura do app empacotado (`npm run smoke`) antes de publicar.
- Modo degradado quando a chave do cofre não pode ser lida (ex.: senha do Windows redefinida): downloads, histórico e
  biblioteca continuam; cookies e Pixiv ficam desativados até o usuário usar **Redefinir cofre**, que põe o cofre
  antigo de lado (sem apagar) e cria um novo.
- Banco de dados corrompido: as linhas legíveis são recuperadas para o banco novo, e o aviso diz quanto foi salvo.
- Modo Python das ferramentas instala só pacotes com versão e hash fixados no manifesto (`--require-hashes`).

### Alterado

- Renderer servido por `app://yami` com CSP estrita, sandbox e validação de remetente e payload em todo IPC.
- Histórico e fila em SQLite dentro da pasta de dados do app; logs rotativos e redigidos (`main.log`, `host.log`).
- Build com esbuild (main, preload e host) e Vite (renderer); `npm run dev` reinicia o Electron ao mudar o código do
  main/host.
- Requisito de desenvolvimento: Node.js ≥ 22.18.
- Um download com alguns erros mas com arquivos baixados agora termina como "Concluído com erros" em vez de "Falhou".
- Ao fechar o app, os downloads em andamento são interrompidos e **continuam sozinhos** na próxima abertura, na
  mesma ordem da fila.
- Observar a área de transferência agora é opcional (desligado por padrão) e nunca rouba o foco.
- As ferramentas são reinstaladas a partir de fontes verificadas; binários antigos de `~/.yami/bin` não são reutilizados.
- A pasta de downloads não pode ser a pasta pessoal inteira, a raiz do disco, uma pasta do sistema ou uma pasta
  compartilhada com outros usuários.

### Corrigido

- Pausar ou fechar o app não apaga mais o que o yt-dlp já tinha baixado: o download continua de onde parou.
- Um engine encerrado no meio (antivírus, falta de memória, Gerenciador de Tarefas) não aparece mais como
  "Concluído": o download termina como "Concluído com erros".
- Excluir uma conversa não apaga mais arquivos que outra conversa também lista.
- Reimportar um cookie durante um download não é mais desfeito quando o download termina.
- O yt-dlp não usa mais ffmpeg/Deno de pastas do PATH que outros usuários podem alterar.
- A importação da 1.x não é mais dada como concluída quando o histórico falha: ela é tentada de novo (até 3 vezes),
  e um banco recriado não a repete.
- Abrir o app com dados de uma versão mais nova não altera mais o banco (o app recusa e avisa).
- Previews e miniaturas não ficam mais quebrados depois de rolar muitos arquivos na biblioteca.
- Os logs de cada download ficam limitados a ~1 MiB quando ele termina.
- No modo Python, atualizar o Python gerenciado não apaga mais o gallery-dl e o yt-dlp: os pacotes são reinstalados
  antes da troca, e se falharem o Python antigo continua.
- Um download com cookie escolhido fica pausado (em vez de falhar e perder os arquivos parciais) enquanto o cofre
  estiver indisponível.
- Uma página ou arquivo arrastado para a janela não ganha mais acesso à API do app.
- Token do Pixiv e cookies não ficam mais em texto puro nem aparecem na linha de comando.
- Download de ferramenta que perdia a conexão travava o app até reiniciar.
- Banco de dados corrompido impedia o app de abrir (agora é recriado, com cópia de segurança).
- Nomes com acentos quebravam caminhos no Windows (UTF-8 forçado nos engines).
- Biblioteca travava com milhares de arquivos (filtros O(n) e listas virtualizadas).
- Renomear pasta na biblioteca sempre falhava e podia alterar pastas vizinhas no histórico.
- O card de um download mostrava o progresso de outro.
- Diversos outros problemas da 1.x (fila, retentativas, notificações duplicadas, bandeja, preview e encerramento).

### Removido

- O _native host_ em JavaScript (`native-host/`) e o carregamento via `ELECTRON_RUN_AS_NODE`.

[Não lançado]: https://github.com/rafaelnassar/Yami/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/rafaelnassar/Yami/releases/tag/v2.0.0
