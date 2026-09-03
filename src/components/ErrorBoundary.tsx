'use client';

import { Component, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Dashboard error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex h-[50vh] items-center justify-center">
          <div className="text-center space-y-4 max-w-md">
            <AlertTriangle className="mx-auto h-12 w-12 text-red-500" />
            <h3 className="text-lg font-semibold">Algo deu errado</h3>
            <p className="text-sm text-muted-foreground">
              {this.state.error?.message || 'Erro desconhecido ao carregar esta página.'}
            </p>
            <Button onClick={() => window.location.reload()}>
              <RefreshCw className="h-4 w-4 mr-1" /> Recarregar
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
