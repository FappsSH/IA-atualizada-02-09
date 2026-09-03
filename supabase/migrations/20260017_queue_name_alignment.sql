-- Align queue names with the runtime code used by webhook-receiver, debounce-worker and ai-processor.

SELECT pgmq.create('messages_vendas')
WHERE NOT EXISTS (
    SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'messages_vendas'
);

SELECT pgmq.create('ai_processing_vendas')
WHERE NOT EXISTS (
    SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'ai_processing_vendas'
);
