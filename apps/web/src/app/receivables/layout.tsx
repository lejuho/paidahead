import { AppShell } from "@/components/app-shell";
// Shared by all three roles; the API decides which receivables and actions each organization may access.
export default function Layout({ children }: { children: React.ReactNode }) { return <AppShell>{children}</AppShell>; }
