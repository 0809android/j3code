import { T, useGT } from "gt-react";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { LegacyImportDialog } from "../onboarding/LegacyImportDialog";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

/** Brings settings, providers and history over from T3 Code at any time. */
export function LegacyImportSettingsRow() {
  const gt = useGT();
  const environmentId = usePrimaryEnvironmentId();
  const [open, setOpen] = useState(false);
  if (environmentId === null) return null;
  return (
    <>
      <SettingsRow
        title={gt("Import from T3 Code")}
        description={
          <T>Bring over settings, providers and history from a T3 Code install on this computer.</T>
        }
        control={
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {gt("Choose what to import")}
          </Button>
        }
      />
      <LegacyImportDialog environmentId={environmentId} open={open} onOpenChange={setOpen} />
    </>
  );
}
