export type StudyStatus = 'generation' | 'other_metadata' | 'missing' | 'partial';
export type StudySection = 'summary' | 'prompts' | 'parameters' | 'raw' | 'notes';
export interface StudyField { key: string; label: string; value: string }
export interface StudySummary {
  id: string; revision: number; name: string; sha256: string;
  mimeType: string; width: number; height: number; byteLength: number;
  sourceUrl: string; sourceAuthor: string; createdAt: string; updatedAt: string;
  archived: boolean; metadataStatus: StudyStatus; metadataKind: string;
  sources: string[]; warnings: string[]; promptFieldCount: number; parameterFieldCount: number;
}
export interface StudyDetail { study: StudySummary; section: StudySection; fields?: StudyField[]; notes?: string; raw?: Record<string, Record<string, string>> }
export interface StudyList { items: StudySummary[]; total: number; offset: number; limit: number; hasMore: boolean; warnings?: string[] }
export interface StudyImage { id: string; sha256: string; name: string; mimeType: string; data: string }
export type StudyRequest =
  | { action: 'import'; name: string; data: string; sourceUrl?: string; sourceAuthor?: string }
  | { action: 'list'; query?: string; offset?: number; limit?: number; includeArchived?: boolean }
  | { action: 'read'; id: string; section?: StudySection }
  | { action: 'image' | 'original'; id: string }
  | { action: 'update'; id: string; expectedRevision: number; patch: Partial<Pick<StudySummary, 'name'|'sourceUrl'|'sourceAuthor'|'archived'>> & { notes?: string } };
export interface ImageStudyApi { materialStudies(args: StudyRequest): Promise<any> }
