// Minimal layout for iframe-embedded surfaces (/embed/*) — none of the
// dashboard chrome (LeftNav, TopBar, FABs, watchers). Pages under this group
// mount their own providers because they depend on the resolved session.

export default function EmbedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="h-dvh bg-secondary">{children}</div>;
}
