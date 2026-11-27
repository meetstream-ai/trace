import { defaultBotSettings, transcriptionProviders, type BotSettings } from "@/lib/meetstream/bot-settings";

export function BotSettingsFields({ settings, onChange, disabled, meetingAgentEnabled }: {
  settings: BotSettings;
  onChange: (value: BotSettings) => void;
  disabled: boolean;
  meetingAgentEnabled: boolean;
}) {
  const provider = transcriptionProviders[settings.provider];
  return (
    <details className="import-options">
      <summary>Bot settings</summary>
      <fieldset className="bot-settings-fields" disabled={disabled}>
        <div className="form-grid">
          <label className="field">
            Bot name
            <input value={settings.name} maxLength={80} placeholder={defaultBotSettings.name}
              onChange={(event) => onChange({ ...settings, name: event.target.value })} />
          </label>
          <label className="field">
            Transcription provider
            <select value={settings.provider} onChange={(event) => onChange({
              ...settings, provider: event.target.value as BotSettings["provider"],
              language: undefined, model: undefined,
            })}>
              {Object.entries(transcriptionProviders).map(([id, option]) =>
                <option key={id} value={id}>{option.label}</option>
              )}
            </select>
          </label>
          {provider.languageField && (
            <label className="field">
              Language code
              <input value={settings.language ?? ""} maxLength={32}
                placeholder={`Provider default (e.g. ${provider.languageExample})`}
                onChange={(event) => onChange({ ...settings, language: event.target.value })} />
            </label>
          )}
          {provider.modelField && (
            <label className="field">
              Model
              <input value={settings.model ?? ""} maxLength={64}
                placeholder={`Provider default (e.g. ${provider.modelExample})`}
                onChange={(event) => onChange({ ...settings, model: event.target.value })} />
            </label>
          )}
        </div>
        {settings.provider !== "meetstream" && (
          <p className="field-hint">Add your {provider.label} key under Integrations → Transcription in the MeetStream dashboard.</p>
        )}
        <label className="checkbox-label">
          <input type="checkbox" checked={settings.recordVideo}
            onChange={(event) => onChange({ ...settings, recordVideo: event.target.checked })} />
          <span>Record video as well as audio</span>
        </label>
        {meetingAgentEnabled && (
          <label className="checkbox-label">
            <input type="checkbox" checked={settings.runAgent}
              onChange={(event) => onChange({ ...settings, runAgent: event.target.checked })} />
            <span>Run meeting agent <small>Send live phrases and meeting events to your configured handler.</small></span>
          </label>
        )}
        {settings.recordVideo && (
          <label className="field">
            Video layout
            <select value={settings.videoLayout} onChange={(event) => onChange({
              ...settings, videoLayout: event.target.value as BotSettings["videoLayout"],
            })}>
              <option value="speaker_view">Active speaker</option>
              <option value="grid_view">Gallery</option>
            </select>
          </label>
        )}
      </fieldset>
    </details>
  );
}
