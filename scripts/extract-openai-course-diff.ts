import { COURSE_CATALOG_ENTRIES } from './course-catalog-dataset.ts';

const fileId = process.argv[2];

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY nao configurada.');
  process.exit(1);
}

if (!fileId) {
  console.error('Informe file_id.');
  process.exit(1);
}

const known = Array.from(new Set(COURSE_CATALOG_ENTRIES.map((item) => item.display_name))).sort();

const prompt = [
  'Leia arquivo anexado.',
  'Compare com lista KNOWN_COURSES abaixo.',
  'Devolva apenas cursos que existem no arquivo, mas NAO existem em KNOWN_COURSES.',
  'Formato: JSON valido { "filename": string, "courses": [{ "display_name": string, "duration_text": string, "delivery_mode": string }] }.',
  'Se nao houver curso novo, devolva courses vazio.',
  `KNOWN_COURSES=${JSON.stringify(known)}`,
].join(' ');

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
console.log(text);
if (!res.ok) process.exit(1);
