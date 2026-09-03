import { getStageBadgeColor, getStageLabel } from '@/lib/utils';

interface LeadsByStageProps {
  stageCounts: Record<string, number>;
  loading?: boolean;
}

const STAGES = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'handoff', 'encerrado'];

export function LeadsByStage({ stageCounts, loading }: LeadsByStageProps) {
  const total = Object.values(stageCounts).reduce((a, b) => a + b, 0) || 1;

  return (
    <div className="rounded-lg border bg-card p-6">
      <h3 className="mb-4 text-base font-semibold">Leads por Etapa</h3>
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-6 w-full rounded bg-muted animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex h-8 w-full overflow-hidden rounded-full">
            {STAGES.map((stage) => {
              const count = stageCounts[stage] || 0;
              const pct = (count / total) * 100;
              if (pct < 0.5) return null;
              return (
                <div
                  key={stage}
                  className={`${getStageBadgeColor(stage)} flex items-center justify-center text-xs font-medium text-white transition-all`}
                  style={{ width: `${pct}%`, minWidth: count > 0 ? '24px' : '0' }}
                  title={`${getStageLabel(stage)}: ${count}`}
                >
                  {pct > 5 ? count : ''}
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            {STAGES.map((stage) => (
              <div key={stage} className="flex items-center gap-2">
                <div className={`h-3 w-3 rounded-full ${getStageBadgeColor(stage)}`} />
                <span className="text-muted-foreground">{getStageLabel(stage)}</span>
                <span className="font-medium">{stageCounts[stage] || 0}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
