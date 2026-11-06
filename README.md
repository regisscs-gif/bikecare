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

## Publicar (custo zero): Supabase + Render + Cloudflare Pages
1. **Banco (Supabase):** novo projeto → Connect → **Session pooler** (porta 5432; o Render grátis só tem IPv4, então não use a conexão direta). Copie a string e troque `[YOUR-PASSWORD]` pela senha do projeto. Em Project Settings → Data API, se possível, desative a Data API (as tabelas também ficam protegidas por RLS automaticamente: `ENABLE_RLS=true`).
2. **API (Render):** New → Blueprint → este repositório (`render.yaml`, plano Free). Preencha `DATABASE_URL`, `TOKEN_ENC_KEY` (`openssl rand -base64 32`) e `ADMIN_EMAILS`. Na primeira subida as migrações rodam e a biblioteca é carregada e publicada.
3. **Manter a API acordada:** o plano Free dorme após 15 min sem uso. Crie um monitor gratuito (UptimeRobot ou cron-job.org) em `https://SUA-API.onrender.com/health` a cada 5 min.
4. **App web (Cloudflare Pages):** conecte o repositório. Root directory `apps/mobile`; build `cd ../.. && npm ci && cd apps/mobile && npx expo export --platform web`; output `dist`. Variáveis: `NODE_VERSION=22`, `EXPO_PUBLIC_API_URL` (URL da API, sem barra final), `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`.
5. **Google:** client ID do tipo Web com a URL `.pages.dev` em "Authorized JavaScript origins"; o mesmo ID em `GOOGLE_CLIENT_IDS` (Render) e `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (Pages, depois redeploy). Adicione os e-mails de teste na tela de consentimento.
