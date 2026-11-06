/**
 * Copy of the queue page (step 4b2, prototype 17–19), each key as [中文, English] under the rules of strings.ts.
 * Keys start with "q.". Merged into UI_STRINGS (strings.ts); strings.test.ts checks them with the rest.
 * 中文里「项目」专指历史分组（Projects），批次里的每一张叫「条目」或「图片」。
 */
export const QUEUE_STRINGS = {
  'q.title': ['队列', 'Queue'],
  'q.noToken': ['还没有填 NovelAI token，队列暂时不能出图。', 'No NovelAI token yet, so the queue can’t generate.'],
  'q.openSettings': ['填写 token', 'Add token'],
  'q.recordsBroken': ['已清理批次的记录损坏或缺失：恢复之前，Agent 查询或入队没有回执的请求一律被拒绝（不会重复出图）。', 'The records of cleaned batches are damaged or missing: until they are restored, agent lookups and enqueues without a receipt are refused (nothing is generated twice).'],
  'q.recordsOpen': ['查看恢复办法', 'How to recover'],

  // ── List ──────────────────────────────────────────────────────────────────
  'q.summary': ['生成中 {a} · 等待 {b} · 今天完成 {c} 张', '{a} running · {b} waiting · {c} done today'],
  'q.filter': ['筛选批次', 'Filter batches'],
  'q.f.all': ['全部', 'All'],
  'q.f.open': ['未结束', 'Unfinished'],
  'q.f.ended': ['已结束', 'Finished'],
  'q.g.active': ['进行中', 'In progress'],
  'q.g.waiting': ['等待中', 'Waiting'],
  'q.g.ended': ['已结束', 'Finished'],
  'q.list': ['批次', 'Batches'],
  'q.more': ['显示更多（还有 {n} 个）', 'Show more ({n} left)'],
  'q.filterEmpty': ['这里没有批次', 'No batches here'],
  'q.loading': ['正在读取队列…', 'Loading the queue…'],
  'q.readFailed': ['队列读不出来', 'The queue couldn’t be read'],
  'q.empty.t': ['队列是空的', 'The queue is empty'],
  'q.empty.d': ['Agent 入队或在画布上点「生成」后，出图批次会出现在这里。', 'Batches show up here when an agent enqueues images or you click Generate on the canvas.'],

  // ── Status ────────────────────────────────────────────────────────────────
  'q.s.queued': ['排队', 'Queued'],
  'q.s.running': ['生成中', 'Running'],
  'q.s.pausing': ['暂停中', 'Pausing'],
  'q.s.paused': ['已暂停', 'Paused'],
  'q.s.cancelling': ['取消中', 'Cancelling'],
  'q.s.succeeded': ['已完成', 'Done'],
  // partial: the batch ran to its end, but some images failed or have an unknown result (none is resent).
  'q.s.partial': ['部分完成', 'Partly done'],
  'q.s.cancelled': ['已取消', 'Cancelled'],
  // blocked: only batches stored by older versions, which stopped a batch at its first unsuccessful image.
  'q.s.blocked': ['已中止', 'Stopped'],
  'q.flag.unknown': ['结果未知', 'Unknown result'],
  'q.flag.failed': ['有图片失败', 'Some images failed'],

  // ── Batch title, meta and progress ────────────────────────────────────────
  'q.src.manualRun': ['手动 · 本次运行', 'Manual · this run'],
  'q.t.mode': ['{mode}批次', '{mode} batch'],
  'q.m.source': ['来源', 'Source'],
  'q.m.project': ['项目', 'Project'],
  'q.m.mode': ['模式', 'Mode'],
  'q.m.count': ['张数', 'Images'],
  'q.m.interval': ['间隔', 'Interval'],
  'q.m.enqueued': ['入队', 'Enqueued'],
  'q.m.sec': ['{n} 秒', '{n}s'],
  'q.progress': ['{done} / {total} 张', '{done} of {total}'],
  'q.progressLabel': ['已完成 {done} / {total} 张', '{done} of {total} done'],
  'q.eta': ['约 {n} 分钟完成', 'About {n} min left'],
  'q.etaSoon': ['不到 1 分钟完成', 'Less than a minute left'],

  // ── Actions ───────────────────────────────────────────────────────────────
  'q.pause': ['暂停后续', 'Pause'],
  'q.pauseTip': ['当前这张完成后暂停，只作用于这个批次', 'Pauses after the current image, for this batch only'],
  'q.resume': ['继续', 'Resume'],
  'q.resumeTip': ['接着出图，仍用入队时的配方', 'Continues with the recipes from enqueue time'],
  'q.resumeNoToken': ['先填写 NovelAI token 才能继续。', 'Add your NovelAI token before resuming.'],
  'q.cancel': ['取消批次', 'Cancel batch'],
  'q.cancel.title': ['取消这个批次？', 'Cancel this batch?'],
  'q.cancel.body': ['还没开始的 {n} 张不再生成，已完成的图片留在素材库里。', 'The {n} images not started yet won’t be generated. Finished images stay in the library.'],
  'q.cancel.body.one': ['还没开始的 {n} 张不再生成，已完成的图片留在素材库里。', 'The {n} image not started yet won’t be generated. Finished images stay in the library.'],
  'q.cancel.bodyNone': ['没有还没开始的图片，已完成的图片留在素材库里。', 'No images are waiting to start. Finished images stay in the library.'],
  'q.cancel.charged': ['正在生成的那一张会尽量中止，但可能已经扣费。', 'The image being generated is stopped if possible, but it may already have been charged.'],
  'q.cancel.confirm': ['取消批次', 'Cancel batch'],
  'q.cancel.keep': ['不取消', 'Keep it'],
  // Review rework (4b2 P1): confirmations name their batch and close themselves when the batch changed meanwhile.
  'q.confirmClosedEnded': ['确认框打开期间这个批次已经结束，没有执行操作。', 'This batch ended while the confirmation was open; nothing was done.'],
  'q.confirmClosedChanged': ['确认框打开期间这个批次的状态变了，没有执行操作。', 'This batch changed while the confirmation was open; nothing was done.'],
  'q.actsLabel': ['批次操作', 'Batch actions'],
  'q.m.projectLoading': ['读取中…', 'Loading…'],
  'q.stateChanged': ['状态已变为「{status}」', 'Now {status}'],
  'q.next.ended': ['这个批次已结束', 'This batch has ended'],
  'q.next.running': ['正在出图', 'Generating now'],
  'q.next.waiting': ['下一个开始', 'Starts next'],
  'q.next.open': ['查看正在进行的批次：{name}', 'Show the batch in progress: {name}'],

  // ── Notes (what happened + what next) ─────────────────────────────────────
  'q.note.pause': ['当前这张完成后才会暂停。', 'It pauses once the current image is done.'],
  'q.note.paused': ['已暂停。点「继续」接着出图。', 'Paused. Resume to continue.'],
  'q.note.queued': ['排在队列里，轮到它时自动开始。', 'Waiting in the queue; it starts on its turn.'],
  'q.note.cancelling': ['正在取消：正在生成的那一张结束后批次停下。', 'Cancelling: the batch stops once the current image ends.'],
  'q.note.unknown': ['{n} 张结果未知，可能已出图并扣费。不会自动重发；重做之前，请先在素材库里核对这个批次出的图。', '{n} images have an unknown result and may have been generated and charged. They won’t be resent; before redoing them, check this batch’s images in the library.'],
  'q.note.unknown.one': ['{n} 张结果未知，可能已出图并扣费。不会自动重发，请先在素材库里核对。', '{n} image has an unknown result and may have been generated and charged. It won’t be resent; check the library first.'],
  'q.note.failed': ['{n} 张失败，不会自动重试。', '{n} images failed and won’t be retried.'],
  'q.note.failed.one': ['{n} 张失败，不会自动重试。', '{n} image failed and won’t be retried.'],
  'q.note.failedFirst': ['第 {index} 张：{reason}', 'Image {index}: {reason}'],
  // What NovelAI answered to a failed agent image (step 4c1; kept for this window only, cleaned)
  'q.up.said': ['NovelAI 返回{http}：{message}', 'NovelAI said{http}: {message}'],
  'q.up.http': ['（HTTP {status}）', ' (HTTP {status})'],
  'q.up.status': ['NovelAI 返回 HTTP {status}', 'NovelAI answered HTTP {status}'],
  'q.note.check': ['到素材库核对', 'Check in library'],

  // ── Images of a batch ─────────────────────────────────────────────────────
  'q.items': ['图片', 'Images'],
  'q.openAll': ['在素材库中查看全部', 'Open all in library'],
  'q.openHistory': ['打开历史成图', 'Open history'],
  'q.item.succeeded': ['第 {index} 张，已完成 · 在素材库中打开', 'Image {index}, done · open it in the library'],
  'q.item.running': ['生成中', 'Generating'],
  'q.item.submitting': ['提交中', 'Submitting'],
  'q.item.pending': ['排队', 'Waiting'],
  'q.item.failed': ['失败', 'Failed'],
  'q.item.unknown': ['未知', 'Unknown'],
  'q.item.cancelled': ['已取消', 'Cancelled'],
  'q.item.skipped': ['未生成', 'Not generated'],
  'q.item.unknownTip': ['结果未知，可能已出图并扣费，不会重发', 'Unknown result: it may have been generated and charged, and it isn’t resent'],
  'q.item.thumbFailed': ['缩略图读不出来', 'The thumbnail couldn’t be read'],

  // ── Technical details ─────────────────────────────────────────────────────
  'q.tech.batch': ['批次编号', 'Batch ID'],
  'q.tech.request': ['请求键', 'Request key'],
  'q.tech.plan': ['配方计划', 'Recipe plan'],
  'q.tech.items': ['各条', 'Items'],
  'q.tech.job': ['任务', 'Job'],
  'q.tech.seed': ['种子', 'Seed'],
  'q.tech.copyAll': ['复制全部', 'Copy all'],
  'q.tech.showAll': ['显示全部 {n} 条', 'Show all {n}'],
  'q.tech.copyFailed': ['复制失败，可以手动选中再复制。', 'Couldn’t copy; select the text and copy it yourself.'],
} as const satisfies Record<string, readonly [string, string]>;
