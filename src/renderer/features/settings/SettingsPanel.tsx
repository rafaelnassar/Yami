/** Settings modal body. Each section has its own error boundary. */
import { useEffect, useState, type ReactNode } from 'react';
import { Wrench } from 'lucide-react';
import type { AppInfo } from '../../../shared/contracts/ipc.ts';
import { ErrorBoundary } from '../../app/ErrorBoundary.tsx';
import { useServices } from '../../app/services-context.tsx';
import { useT } from '../../shared/i18n/i18n-context.tsx';
import { AccountsSection } from './AccountsSection.tsx';
import { CookiesSection } from './cookies/CookiesSection.tsx';
import { BehaviorSection, DownloadDirSection, LanguageSection, PrivacySection } from './GeneralSections.tsx';
import { RuntimeToolsPanel } from './runtime/RuntimeToolsPanel.tsx';
import { SettingsBlock } from './SettingsBlock.tsx';
import { UpdatesSection } from './updates/UpdatesSection.tsx';

function Section({ children }: { children: ReactNode }) {
  return <ErrorBoundary>{children}</ErrorBoundary>;
}

export function SettingsPanel() {
  const t = useT();
  const { client } = useServices();
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let active = true;
    void client
      .value((api) => api.app.getInfo())
      .then((result) => {
        if (active && result.ok) setInfo(result.data);
      });
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <div className="flex flex-col gap-5">
      <Section>
        <LanguageSection />
      </Section>
      <Section>
        <BehaviorSection />
      </Section>
      <Section>
        <SettingsBlock title={t.t('ui.runtime.title')} icon={Wrench}>
          <RuntimeToolsPanel />
        </SettingsBlock>
      </Section>
      <Section>
        <PrivacySection />
      </Section>
      <Section>
        <DownloadDirSection />
      </Section>
      <Section>
        <AccountsSection secretsProtected={info?.secretsProtected ?? null} />
      </Section>
      <Section>
        <CookiesSection />
      </Section>
      <Section>
        <UpdatesSection version={info?.version ?? null} />
      </Section>
    </div>
  );
}
