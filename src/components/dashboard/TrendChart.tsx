'use client';

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

interface Props {
  data: { date: string; leads: number; matriculas: number }[];
}

export default function TrendChart({ data }: Props) {
  if (!data.length) {
    return (
      <div className="flex h-[300px] min-h-[300px] items-center justify-center text-sm text-muted-foreground">
        Sem dados suficientes para o gráfico.
      </div>
    );
  }

  return (
    <div className="h-[300px] min-h-[300px] w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={12} />
          <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '8px',
              color: 'hsl(var(--foreground))',
            }}
          />
          <Legend />
          <Line type="monotone" dataKey="leads" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} name="Novos Leads" />
          <Line type="monotone" dataKey="matriculas" stroke="#22c55e" strokeWidth={2} dot={{ r: 3 }} name="Matrículas" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
