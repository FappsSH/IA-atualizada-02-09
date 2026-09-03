'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  BookOpen,
  Bot,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Send,
  Settings,
  Timer,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/conversas', label: 'Conversas', icon: MessageSquare },
  { href: '/subagentes', label: 'Subagentes', icon: Bot },
  { href: '/conhecimento', label: 'Conhecimento', icon: BookOpen },
  { href: '/regras', label: 'Regras', icon: ListChecks },
  { href: '/prospeccao', label: 'Prospeccao', icon: Send },
  { href: '/followups', label: 'Follow-ups', icon: Timer },
  { href: '/configuracoes', label: 'Configuracoes', icon: Settings },
];

interface SidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ mobileOpen = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    navItems.forEach((item) => {
      router.prefetch(item.href);
    });
  }, [router]);

  return (
    <>
      <div
        className={cn(
          'fixed inset-0 z-40 bg-background/80 backdrop-blur-sm transition-opacity lg:hidden',
          mobileOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
      />

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r bg-card transition-transform duration-200 lg:sticky lg:top-0 lg:z-20 lg:h-screen lg:w-60 lg:max-w-none lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center justify-between border-b px-4 lg:px-6">
          <Link href="/" prefetch className="flex items-center gap-2 text-lg font-semibold" onClick={onClose}>
            <Bot className="h-6 w-6 text-primary" />
            <span>IA Comercial</span>
          </Link>
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {navItems.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch
                onClick={onClose}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <item.icon className="h-5 w-5 shrink-0" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="border-t p-4">
          <p className="text-xs text-muted-foreground">Fapps</p>
          <p className="text-xs text-muted-foreground">v1.0.0</p>
        </div>
      </aside>
    </>
  );
}
