import type { ContentType, DocumentKind, SourceKey } from './classify';
import type { IngestCode } from './errors';

export interface Document {
  source: SourceKey;
  kind: DocumentKind;
  contentType: ContentType;
  title: string;
  author: string;
  publishedAt: string | null;
  text: string;
  canonicalUrl: string;
  nativeAudio: boolean;
}

export interface Preview {
  source: SourceKey;
  kind: DocumentKind;
  contentType: ContentType;
  title: string;
  channel_name: string;
  emoji: string;
  warning?: { code: IngestCode; message: string };
}
