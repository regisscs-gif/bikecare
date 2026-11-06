# BikeCare — MVP

App de manutenção de bicicleta (iOS, Android e web com as mesmas funções). Semáforo de 4 cores por componente, calculado por km, horas e dias, com regras versionadas e fontes.

## Estrutura
- `packages/core` — motor de regras (puro, determinístico, 28 testes).
- `apps/api` — API Fastify + Drizzle + Postgres (45 testes, rodam em PGlite, sem Docker).
- `apps/mobile` — Expo SDK 58 + expo-router (iOS/Android/web).

## Rodar
```bash
npm install
npm test                                  # core + API
docker compose up -d db                   # Postgres local
cd apps/api && cp .env.example .env       # preencha JWT_SECRET, GOOGLE_CLIENT_IDS, ADMIN_EMAILS...
npm run db:migrate
npm run db:seed -- --publish              # biblioteca v1 (em produção, publique as regras pelo painel)
npm run dev                               # API em :3333
cd ../mobile && cp .env.example .env      # EXPO_PUBLIC_API_URL e client IDs do Google
npx expo start                            # w = web, i = iOS, a = Android
```

## Credenciais externas (não dá para gerar em código)
- Google OAuth: um client ID por plataforma (web, iOS, Android); os mesmos IDs em `GOOGLE_CLIENT_IDS` (API).
- Strava: app em strava.com/settings/api; o domínio/redirect `.../strava/callback` precisa estar autorizado. Segredo só no servidor. Para mais de 1 atleta, pedir Extended Access.
- Push: Expo Push (requer `projectId` do EAS para builds nativos).

## Pendências conhecidas
- Painel admin: só a API (`/v1/admin/*`, RBAC, auditoria, importação CSV). Falta a interface web.
- Textos de Termos/Privacidade e metas das métricas de sucesso.
- Login Apple (fase 1.1).
- Consolidação de uso ao desconectar o Strava: validar contra os termos da API do Strava.
- Cache offline do app é somente leitura (último estado carregado).
- Mobile verificado por typecheck e `expo export --platform web`; não testado em aparelho/simulador.

## Publicar (git → hospedagem)
**API + banco (Render):** New → Blueprint → escolha este repositório (usa `render.yaml`). Preencha `GOOGLE_CLIENT_IDS`, `ADMIN_EMAILS` e `TOKEN_ENC_KEY` (`openssl rand -base64 32`). Na primeira subida, as migrações rodam e a biblioteca é carregada e publicada sozinha (`SEED_ON_START`/`SEED_PUBLISH`). Cada push na `main` faz novo deploy.

**App web (Cloudflare Pages):** conecte o repositório. Root directory: `apps/mobile`. Build command: `cd ../.. && npm ci && cd apps/mobile && npx expo export --platform web`. Output directory: `dist`. Variáveis: `EXPO_PUBLIC_API_URL` (URL da API no Render) e `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`. Adicione também um arquivo `_redirects` com `/* /index.html 200` (já incluído em `apps/mobile/public`).

**Google:** no client ID Web, inclua a URL do Pages em "Authorized JavaScript origins".
