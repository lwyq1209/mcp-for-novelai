import type { MetadataSnapshotPayload } from "./types";

/**
 * The image file of a metadata snapshot (the host reads an image of the library for Use on canvas, src/app/
 * ImageActions.tsx). (Step 4c2: the old metadata page's hand-off helpers were removed with that page.)
 */
export function metadataSnapshotToFile(snapshot: MetadataSnapshotPayload): File {
  const binary = atob(snapshot.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], snapshot.name || "metadata-image.png", {
    type: snapshot.type,
    lastModified: snapshot.lastModified,
  });
}
