# Monitor de vagas → Telegram

Consulta a cada 10 minutos as APIs públicas de vagas (Greenhouse, Lever, Ashby e os portais da Gupy e da Sólides),
filtra por cargo e local e avisa no Telegram só o que for novo. Roda no GitHub Actions, de graça.

## 1. Criar o bot do Telegram
1. No Telegram, abra uma conversa com @BotFather, envie `/newbot` e siga as perguntas. Guarde o token.
2. Abra a conversa com o bot criado e mande qualquer mensagem.
3. No navegador, abra `https://api.telegram.org/bot<TOKEN>/getUpdates` e copie o número em `"chat":{"id": ...}`.

## 2. Subir para o GitHub
1. Crie um repositório **privado** e envie todos os arquivos desta pasta (inclusive `.github`).
2. No repositório: Settings > Secrets and variables > Actions > New repository secret. Crie:
   - `TELEGRAM_BOT_TOKEN` com o token
   - `TELEGRAM_CHAT_ID` com o número do chat
3. Aba Actions > Monitor de vagas > Run workflow.

A primeira execução só registra as vagas já abertas e manda uma mensagem de confirmação.
Dali em diante roda sozinho e cada vaga nova chega como uma mensagem.

## 3. Ajustar
Tudo fica em `config.json`:
- `titulos`: a vaga precisa conter um destes termos no título
- `excluir`: termos que descartam a vaga
- `locaisBrasil`: locais aceitos (remoto e Brasília)
- `gupyTermos`: buscas feitas no portal da Gupy
- `solidesTermos`: buscas feitas no portal Sólides Vagas
- `empresas`: páginas de carreira monitoradas diretamente

Para incluir uma empresa, abra a página de vagas dela e veja o endereço:
`job-boards.greenhouse.io/<slug>`, `jobs.lever.co/<slug>` ou `jobs.ashbyhq.com/<slug>`.

## Testar no computador (opcional)
Com Node 20+: `DRY_RUN=1 node monitor.mjs` mostra no terminal o que seria enviado, sem enviar.
Se alguma fonte falhar, o nome dela aparece no log da execução.
