import { z } from "zod";

export const channelPayloadSchema = z.object({
  originalUrl: z.string().url(),
  name: z.string().max(200).default("")
});

export const settingsSchema = z.object({
  monitor: z.object({
    intervalMinutes: z.number().int().min(5).max(1440),
    workWindow: z.object({
      enabled: z.boolean(),
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/)
    })
  }),
  ai: z.object({
    baseUrl: z.string().url(),
    apiKey: z.string(),
    model: z.string().min(1)
  }),
  telegram: z.object({
    botToken: z.string(),
    chatId: z.string()
  }),
  history: z.object({
    retentionDays: z.number().int().min(0).max(3650)
  }),
  ui: z.object({
    showChannelAvatars: z.boolean()
  })
});


