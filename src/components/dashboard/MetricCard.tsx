'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { LucideIcon } from 'lucide-react';

interface MetricCardProps {
  title: string;
  value: number | string;
  icon: LucideIcon;
  description?: string;
  loading?: boolean;
  color?: string;
}

export function MetricCard({ title, value, icon: Icon, description, loading, color }: MetricCardProps) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            {loading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <p className={`text-3xl font-bold ${color || ''}`}>{value}</p>
            )}
            {description && (
              <p className="text-xs text-muted-foreground">{description}</p>
            )}
          </div>
          <div className={`rounded-full p-3 ${color ? color.replace('text-', 'bg-').replace('700', '700/20') : 'bg-primary/10'}`}>
            <Icon className={`h-6 w-6 ${color || 'text-primary'}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
