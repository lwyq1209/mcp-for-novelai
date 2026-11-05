/** Pre-IPC allocation guard. The authoritative material_samples contract and
 * decoder independently enforce the same 20 MiB file limit in the host. */
export const MAX_LOCAL_COVER_BASE64_LENGTH = Math.ceil((20 * 1024 * 1024) / 3) * 4;
export function assertLocalCoverIpcSize(method: string, args: Record<string, unknown>) {
  if (method !== 'material_samples' || args?.action !== 'set_local_cover') return;
  if (typeof args.data !== 'string' || !args.data.length || args.data.length > MAX_LOCAL_COVER_BASE64_LENGTH) {
    throw Object.assign(new Error('本地封面图片须非空且不超过 20 MiB；未发送到宿主。'), { code: 'invalid_argument' });
  }
}
