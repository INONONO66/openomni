export function App() {
  const { electron, chrome, node } = window.desktop.versions;
  return (
    <main className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-400 text-sm">
      OpenOmni Desktop - electron {electron} / chromium {chrome} / node {node}
    </main>
  );
}
