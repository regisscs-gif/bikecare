if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error('JWT_SECRET é obrigatório em produção (mínimo 32 caracteres).');
}

export const config = {
  port: Number(process.env.PORT ?? 3333),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me-dev-secret-change-me',
  googleClientIds: (process.env.GOOGLE_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  strava: {
    clientId: process.env.STRAVA_CLIENT_ID ?? '',
    clientSecret: process.env.STRAVA_CLIENT_SECRET ?? '',
    webhookVerifyToken: process.env.STRAVA_WEBHOOK_VERIFY_TOKEN ?? '',
  },
  /** Primeiros administradores do painel (e-mails separados por vírgula). Depois, gerencie a equipe no painel. */
  adminEmails: (process.env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  tokenEncKey: process.env.TOKEN_ENC_KEY ?? '',
  /** Limites de notificação (seção 12): valores iniciais, ajustáveis. */
  notify: { maxPushPerDay: 2, quietStartHour: 22, quietEndHour: 8, redReminderDays: 7 },
};
