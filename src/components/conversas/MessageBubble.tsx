'use client';

import { useState } from 'react';
import { Mensagem } from '@/lib/types';
import { formatTime } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface MessageBubbleProps {
  mensagem: Mensagem;
}

export function MessageBubble({ mensagem }: MessageBubbleProps) {
  const [showToolCalls, setShowToolCalls] = useState(false);
  const isUser = mensagem.role === 'user';
  const isSystem = mensagem.role === 'system';

  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <div className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
          {mensagem.conteudo}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? 'justify-start' : 'justify-end'} mb-3`}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${
          isUser
            ? 'bg-muted text-foreground rounded-bl-sm'
            : 'bg-primary/20 text-foreground rounded-br-sm'
        }`}
      >
        <p className="text-sm whitespace-pre-wrap">{mensagem.conteudo}</p>
        <div className="flex items-center justify-end gap-2 mt-1">
          {mensagem.etapa_no_momento && (
            <span className="text-[10px] text-muted-foreground">
              {mensagem.etapa_no_momento}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground">
            {formatTime(mensagem.created_at)}
          </span>
        </div>
        {mensagem.tool_calls && mensagem.tool_calls.length > 0 && (
          <div className="mt-2 border-t border-primary/20 pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs gap-1"
              onClick={() => setShowToolCalls(!showToolCalls)}
            >
              {showToolCalls ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              Tool calls ({mensagem.tool_calls.length})
            </Button>
            {showToolCalls && (
              <pre className="mt-1 text-[10px] text-muted-foreground overflow-x-auto">
                {JSON.stringify(mensagem.tool_calls, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
