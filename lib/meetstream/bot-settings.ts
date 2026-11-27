import { z } from "zod";

export const transcriptionProviders = {
  meetstream: { label: "MeetStream", languageField: "language", languageExample: "en", modelField: null, modelExample: "" },
  deepgram: { label: "Deepgram", languageField: "language", languageExample: "en", modelField: "model", modelExample: "nova-3" },
  assemblyai: { label: "AssemblyAI", languageField: "language_code", languageExample: "en_us", modelField: "speech_models", modelExample: "universal-2" },
  jigsawstack: { label: "JigsawStack", languageField: "language", languageExample: "en", modelField: null, modelExample: "" },
  sarvam: { label: "Sarvam AI", languageField: "language_code", languageExample: "en-IN", modelField: "model", modelExample: "saaras:v3" },
  smallest: { label: "Smallest AI", languageField: null, languageExample: "", modelField: "model", modelExample: "pulse" },
} as const;

export const defaultBotSettings = {
  name: "Trace Notetaker",
  provider: "meetstream",
  recordVideo: false,
  runAgent: false,
  videoLayout: "speaker_view",
} as const;

export const botSettingsSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).regex(/^[\p{L}\p{M}\p{N} '._@-]+$/u).default(defaultBotSettings.name),
  provider: z.enum(Object.keys(transcriptionProviders) as (keyof typeof transcriptionProviders)[]).default(defaultBotSettings.provider),
  language: z.string().trim().regex(/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/).optional(),
  model: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/).optional(),
  runAgent: z.boolean().default(defaultBotSettings.runAgent),
  recordVideo: z.boolean().default(defaultBotSettings.recordVideo),
  videoLayout: z.enum(["speaker_view", "grid_view"]).default(defaultBotSettings.videoLayout),
}).superRefine((settings, context) => {
  const provider = transcriptionProviders[settings.provider];
  for (const field of ["language", "model"] as const) {
    if (settings[field] && !provider[`${field}Field`])
      context.addIssue({ code: "custom", path: [field], message: `This provider does not support a custom ${field} in Trace.` });
  }
});

export type BotSettings = z.infer<typeof botSettingsSchema>;

export function botRecordingConfig(settings: BotSettings) {
  const provider = transcriptionProviders[settings.provider];
  const options: Record<string, string | string[]> = {};
  if (settings.language && provider.languageField) options[provider.languageField] = settings.language;
  if (settings.model && provider.modelField)
    options[provider.modelField] = provider.modelField === "speech_models" ? [settings.model] : settings.model;
  return {
    transcript: { provider: { [settings.provider]: options } },
    ...(settings.recordVideo ? { video_layout: settings.videoLayout } : {}),
  };
}
