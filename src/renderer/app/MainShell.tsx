/** Main window layout: title bar, status banners, sidebar, workspace, toasts and overlays. */
import { DownloadSidebar } from '../features/downloads/sidebar/DownloadSidebar.tsx';
import { DownloadWorkspace } from '../features/downloads/workspace/DownloadWorkspace.tsx';
import { HostStatusBanner } from '../features/host/HostStatusBanner.tsx';
import { ToastStack } from '../features/notices/ToastStack.tsx';
import { UpdateBanner } from '../features/settings/updates/UpdateBanner.tsx';
import { DialogHost } from './DialogHost.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { PanelHost } from './PanelHost.tsx';
import { TitleBar } from './shell/TitleBar.tsx';

export function MainShell() {
  return (
    <>
      <div className="app-shell flex h-screen w-screen flex-col overflow-hidden bg-bg">
        <TitleBar />
        <HostStatusBanner />
        <UpdateBanner />
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <ToastStack />
          <ErrorBoundary>
            <DownloadSidebar />
          </ErrorBoundary>
          <ErrorBoundary>
            <DownloadWorkspace />
          </ErrorBoundary>
        </div>
      </div>
      <PanelHost />
      <DialogHost />
    </>
  );
}
