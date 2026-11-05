import type { HostErrorTexts } from "./types";

/**
 * Danbooru (electron/danbooru-service.ts): tag search, single-tag examples and covers (step 4c1). The host's message
 * stays what MCP has always read; the window shows these texts by reason.
 */
export const DANBOORU_ERROR_TEXTS: HostErrorTexts = {
  "danbooru.invalid_data": { "zh-CN": "Danbooru 返回的数据格式无效。", "en-US": "Danbooru answered with data in an invalid format." },
  "danbooru.range": { "zh-CN": "页码、数量或作品 ID 超出范围。", "en-US": "The page, count or post ID is out of range." },
  "danbooru.query_text": { "zh-CN": "搜索内容必须是最多 500 字符的单行文字。", "en-US": "A search is one line of at most 500 characters." },
  "danbooru.rating": { "zh-CN": "分级必须是 g、s、q 或 e。", "en-US": "The rating must be g, s, q or e." },
  "danbooru.rating_blocked": { "zh-CN": "这条记录不属于当前选择的 rating:{rating} 分级。", "en-US": "This post is not in the chosen rating:{rating}." },
  "danbooru.post_id_missing": { "zh-CN": "作品 ID 缺失。", "en-US": "The post ID is missing." },
  "danbooru.image_size": { "zh-CN": "图片尺寸无效或超过 64 百万像素。", "en-US": "The image size is invalid or larger than 64 megapixels." },
  "danbooru.image_unavailable": { "zh-CN": "这条记录没有可读取的 Danbooru 静态预览。", "en-US": "This post has no Danbooru still preview to read." },
  "danbooru.image_type": { "zh-CN": "远程响应不是支持的图片。", "en-US": "The answer is not a supported image." },
  "danbooru.http": { "zh-CN": "Danbooru 请求失败（HTTP {status}）。请修改搜索或稍后手动重试。", "en-US": "The Danbooru request failed (HTTP {status}). Change the search or try again later." },
  "danbooru.redirect": { "zh-CN": "Danbooru 请求发生了未允许的跳转。", "en-US": "The Danbooru request was redirected somewhere not allowed." },
  "danbooru.too_large": { "zh-CN": "远程响应超过大小上限。", "en-US": "The answer is larger than allowed." },
  "danbooru.empty": { "zh-CN": "远程响应为空。", "en-US": "The answer was empty." },
  "danbooru.timeout": { "zh-CN": "Danbooru 请求超时；尚未重试。", "en-US": "The Danbooru request timed out; it was not retried." },
  "danbooru.network": { "zh-CN": "Danbooru 网络请求失败；尚未重试。", "en-US": "Danbooru could not be reached; it was not retried." },
  "danbooru.invalid_json": { "zh-CN": "Danbooru 返回的 JSON 无效。", "en-US": "Danbooru answered with invalid JSON." },
  "danbooru.post_id_required": { "zh-CN": "需要作品 ID。", "en-US": "A post ID is needed." },
  "danbooru.other_post": { "zh-CN": "Danbooru 返回了不同的作品。", "en-US": "Danbooru answered with a different post." },
  "danbooru.rating_query": { "zh-CN": "查询中的 rating 必须与单独选择的分级一致。", "en-US": "A rating in the search must match the chosen rating." },
  "danbooru.no_posts": { "zh-CN": "Danbooru 没有返回作品列表。", "en-US": "Danbooru returned no list of posts." },
  "danbooru.too_many": { "zh-CN": "Danbooru 返回数量超过请求页大小。", "en-US": "Danbooru returned more posts than the page holds." },
  "danbooru.variant": { "zh-CN": "图片类型只能是 sample 或 preview。", "en-US": "The image kind must be sample or preview." },
  "danbooru.category": { "zh-CN": "候选类别仅支持 artist。", "en-US": "Only the artist category can be searched." },
  "danbooru.tag_required": { "zh-CN": "请输入标签文字。", "en-US": "Enter a tag." },
  "danbooru.tag_check": { "zh-CN": "Danbooru 标签核对响应无效。", "en-US": "Danbooru’s answer to the tag check is invalid." },
  "danbooru.tag_prefix": { "zh-CN": "请输入单个标签前缀，不包含搜索操作符。", "en-US": "Enter one tag prefix, without search operators." },
  "danbooru.no_tags": { "zh-CN": "Danbooru 没有返回标签列表。", "en-US": "Danbooru returned no list of tags." },
  "danbooru.too_many_tags": { "zh-CN": "Danbooru 返回数量超过标签请求上限。", "en-US": "Danbooru returned more tags than asked for." },
};
