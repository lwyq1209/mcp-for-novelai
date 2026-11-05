import { parentPort, workerData } from 'node:worker_threads';
import { parseImageStudy } from './image-study-parser';

void parseImageStudy(new Uint8Array(workerData.bytes)).then(
  result => parentPort!.postMessage({ ok: true, result }),
  error => parentPort!.postMessage({ ok: false, error: { code: typeof error?.code === 'string' ? error.code : 'study_parse_failed', message: error instanceof Error ? error.message : 'Image study failed.',
    ...(typeof error?.reason === 'string' ? { reason: error.reason } : { reason: 'study.parse_failed' }), ...(error?.params && typeof error.params === 'object' ? { params: error.params } : {}) } }),
);
