import { nativeLanguageName } from "@t3tools/client-runtime/locales";
import { GlobeIcon } from "lucide-react";
import { useId } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { SUPPORTED_LOCALES } from "../../i18n/locales";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** Always English: a reader who cannot read the current language must still find this. */
export function WelcomeLanguageSwitcher() {
  const language = useClientSettings((settings) => settings.language);
  const labelId = useId();
  const value = SUPPORTED_LOCALES.includes(language) ? language : "ja";

  return (
    <div className="flex flex-col items-center gap-2">
      <span id={labelId} className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <GlobeIcon className="size-4 text-icon-muted" aria-hidden />
        {/* oxlint-disable-next-line t3code/no-untranslated-copy -- the language picker stays English so it is findable from any UI language */}
        Language
      </span>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next) void updateClientSettings({ language: next }).catch(() => undefined);
        }}
      >
        <SelectTrigger size="lg" className="w-56" aria-labelledby={labelId}>
          <SelectValue>{nativeLanguageName(value)}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {SUPPORTED_LOCALES.map((locale) => (
            <SelectItem hideIndicator key={locale} value={locale}>
              {nativeLanguageName(locale)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
