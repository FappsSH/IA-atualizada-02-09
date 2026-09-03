const fileIds = process.argv.slice(2);

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY nao configurada.');
  process.exit(1);
}

if (!fileIds.length) {
  console.error('Informe ao menos um file_id.');
  process.exit(1);
}

const prompt =
  'Leia o arquivo anexado e devolva apenas JSON valido neste formato: ' +
  '{"filename":string,"courses":[{"display_name":string,"duration_text":string,"delivery_mode":string}]}. ' +
  'Nao invente nada. Preserve uma linha por curso. Se um curso tiver observacao no nome, mantenha.';

for (const fileId of fileIds) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_file', file_id: fileId },
          ],
        },
      ],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`Falha ao ler ${fileId}: ${text}`);
    process.exit(1);
  }

  console.log(text);
}
