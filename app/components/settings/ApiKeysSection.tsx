import { isServerBackend } from "~/lib/backend/mode";
import { Check, Eye, EyeOff, KeyRound } from "lucide-react";
import { useState } from "react";
import { useSettingsStore } from "~/stores/settingsStore";
import type { ApiKeyProvider } from "~/types";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

const providers: { id: ApiKeyProvider; name: string; description: string; link: string }[] = [
  {
    id: "google",
    name: "Google AI",
    description: "For Gemini image generation models",
    link: "https://aistudio.google.com/",
  },
  {
    id: "replicate",
    name: "Replicate",
    description: "For Flux, GPT Image, and other community models",
    link: "https://replicate.com/",
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "For GPT Image generation models",
    link: "https://platform.openai.com/api-keys",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "For image and text models from multiple providers",
    link: "https://openrouter.ai/settings/keys",
  },
];

export function ApiKeysSection() {
  const apiKeys = useSettingsStore((s) => s.apiKeys);
  const setApiKey = useSettingsStore((s) => s.setApiKey);

  return (
    <section id="api-keys" className="group">
      <SettingsSectionHeader
        icon={KeyRound}
        title="API Keys"
        subtitle={`Manage your API keys for different services. Keys are stored ${
          isServerBackend
            ? "on this Prismix server, which uses them to run generations"
            : "locally in your browser"
        }.`}
      />

      <div className="space-y-3 pl-6">
        {providers.map((provider) => (
          <ApiKeyInput
            key={provider.id}
            provider={provider.id}
            name={provider.name}
            description={provider.description}
            value={apiKeys[provider.id] || ""}
            onChange={(value) => setApiKey(provider.id, value || null)}
            link={provider.link}
          />
        ))}
      </div>
    </section>
  );
}

function ApiKeyInput({
  provider,
  name,
  description,
  value,
  onChange,
  link,
}: {
  provider: ApiKeyProvider;
  name: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  link: string;
}) {
  const [showKey, setShowKey] = useState(false);
  const hasKey = value.length > 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div>
          <label className="text-text-secondary text-sm font-medium">{name}</label>
          <p className="text-text-muted text-xs">
            {description} -
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-muted ml-1 hover:underline"
            >
              Get API key
            </a>
          </p>
        </div>
        {hasKey && <Check className="h-4 w-4 text-green-500" />}
      </div>
      <div className="relative">
        <input
          type={showKey ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={`Enter ${name} API key`}
          className="border-c-border bg-surface-overlay text-text-primary placeholder-text-muted w-full rounded-lg border px-3 py-2 pr-10 text-sm transition-colors focus:border-purple-500 focus:ring-1 focus:ring-purple-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => setShowKey(!showKey)}
          className="text-text-tertiary hover:text-text-secondary absolute top-1/2 right-2 -translate-y-1/2 p-1 transition-colors"
        >
          {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
