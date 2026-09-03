'use client';

import { useState, useEffect, useCallback } from 'react';
import { serverQuery } from '@/lib/supabase';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Wifi, WifiOff, Menu } from 'lucide-react';
import { useRealtime } from '@/hooks/useRealtime';
import { Button } from '@/components/ui/button';

interface HeaderProps {
  onOpenMenu?: () => void;
}

export function Header({ onOpenMenu }: HeaderProps) {
  const [whatsappStatus, setWhatsappStatus] = useState<string>('verificando');

  const fetchStatus = useCallback(async () => {
    const { data, error } = await serverQuery<any>('whatsapp_instances', {
      columns: 'status',
      limit: 1,
    });

    if (!error && data && data.length > 0) {
      setWhatsappStatus(data[0].status);
      return;
    }

    setWhatsappStatus('sem instância');
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useRealtime<any>('whatsapp_instances', fetchStatus);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-card/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-card/80 lg:px-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpenMenu}>
          <Menu className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-base font-semibold sm:text-lg">AgenteHub - Fapps</h1>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Badge
          variant={
            whatsappStatus === 'conectado'
              ? 'success'
              : whatsappStatus === 'verificando'
                ? 'outline'
                : 'destructive'
          }
          className="cursor-pointer gap-1.5 text-[11px] sm:text-xs"
          onClick={fetchStatus}
        >
          {whatsappStatus === 'conectado' ? (
            <Wifi className="h-3.5 w-3.5" />
          ) : (
            <WifiOff className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">WhatsApp {whatsappStatus}</span>
          <span className="sm:hidden">{whatsappStatus}</span>
          <RefreshCw className="ml-1 h-3 w-3 text-muted-foreground" />
        </Badge>
      </div>
    </header>
  );
}
