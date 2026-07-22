export interface TemplatePluginSettings {
  logConnections?: boolean;
  logActivations?: boolean;
}

interface TemplateServerSettings extends Record<string, unknown> {
  templatePlugin?: TemplatePluginSettings;
}

export interface ResolvedTemplatePluginSettings {
  logConnections: boolean;
  logActivations: boolean;
}

export function loadPluginSettings(): ResolvedTemplatePluginSettings {
  const settings = mp.getServerSettings<TemplateServerSettings>().templatePlugin;
  return {
    logConnections: settings?.logConnections ?? true,
    logActivations: settings?.logActivations ?? true,
  };
}
