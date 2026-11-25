export const providers = ['openai', 'claude'] as const;
export type Provider = typeof providers[number];
export const providerNames: Record<Provider, string> = { openai: 'OpenAI', claude: 'Claude' };
