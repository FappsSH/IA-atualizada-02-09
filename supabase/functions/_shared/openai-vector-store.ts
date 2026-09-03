// OpenAI Vector Store helpers for catalog search.
// deno-lint-ignore-file
// @ts-nocheck

export async function searchVectorStore(params: {
  apiKey: string;
  vectorStoreId: string;
  query: string;
  maxNumResults?: number;
  rewriteQuery?: boolean;
}) {
  if (!params.apiKey) {
    throw new Error('OPENAI_API_KEY nao configurada');
  }
  if (!params.vectorStoreId) {
    throw new Error('OPENAI_VECTOR_STORE_ID nao configurado');
  }
  if (!params.query?.trim()) {
    return [];
  }

  const res = await fetch(
    `https://api.openai.com/v1/vector_stores/${params.vectorStoreId}/search`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: params.query,
        max_num_results: params.maxNumResults ?? 8,
        rewrite_query: params.rewriteQuery ?? true,
      }),
    },
  );

  const text = await res.text();
  const json = JSON.parse(text || '{}');
  if (!res.ok) {
    throw new Error(json?.error?.message || `Vector Store search HTTP ${res.status}`);
  }

  return (json.data || []).map((item: any) => ({
    file_id: item.file_id,
    filename: item.filename,
    score: item.score,
    content: (item.content || [])
      .map((part: any) => part.text)
      .filter(Boolean)
      .join('\n'),
  }));
}
