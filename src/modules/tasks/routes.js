'use strict';

const { z } = require('zod');
const { defineModule } = require('../../core/route');

const Task = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.enum(['queued', 'running', 'done', 'failed']),
  stage: z.string().nullable(),
  progress: z.number().int(),
  eta_s: z.number().int().nullable(),
  result: z.record(z.string(), z.any()).nullable(),
  error: z.string().nullable(),
});

// Uzun işin durumu (şablon — BE-29). İstemci 1 sn → 2 sn → … aralıkla sorar (skill: long-running-jobs);
// cevap 'private, no-cache' (ETag ile değişmediyse 304).
module.exports = defineModule('tasks', '/jobs', [
  {
    method: 'get',
    path: '/:id',
    summary: 'Uzun işin durumu: aşama, ilerleme, tahmini süre, sonuç',
    auth: 'required',
    request: { params: z.object({ id: z.string().uuid() }) },
    response: Task,
    handler: ({ user, params, deps }) => deps.tasks.get(user, params.id),
  },
]);
