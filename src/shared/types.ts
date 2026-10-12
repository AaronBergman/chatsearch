export type Source = 'claude' | 'chatgpt';
export const SOURCES: Source[] = ['claude', 'chatgpt'];
export const SOURCE_LABEL: Record<Source, string> = { claude: 'Claude', chatgpt: 'ChatGPT' };

export type Role = 'user' | 'assistant' | 'system' | 'tool';
/** Where a piece of text came from inside a message. */
export type MsgKind = 'text' | 'artifact' | 'attachment' | 'thinking' | 'code';

export interface Message {
  role: Role;
  text: string;
  kind?: MsgKind;
  ts?: number;
  /** native message id (used for jump-to-message) */
  mid?: string;
  /** false when the message is on an abandoned branch (edited / regenerated) */
  main?: boolean;
}

/** Lightweight per-conversation record, always kept in memory by the engine. */
export interface ConvMeta {
  id: string; // `${source}:${nativeId}`
  source: Source;
  nativeId: string;
  org?: string;
  title: string;
  summary?: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  project?: string;
  projectId?: string;
  starred?: boolean;
  archived?: boolean;
  url: string;
  /** updatedAt of the version whose content is stored (content is stale if < updatedAt) */
  fetchedUpdatedAt?: number;
  fetchedAt?: number;
  /** last time content came from a page capture instead of a direct fetch */
  capturedAt?: number;
  msgCount?: number;
  chars?: number;
  /** consecutive fetch failures (permanent failures stop retrying after a few) */
  errors?: number;
  lastError?: string;
}

export interface ConvContent {
  id: string;
  messages: Message[];
}

/** Derived search record (rebuildable from content). */
export interface IndexRec {
  id: string;
  v: number;
  /** normalized body: messages joined with \u0000, length-preserving vs originals */
  norm: string;
  /** start offset of each message in norm */
  starts: Int32Array;
  /** role code per message: 0 user, 1 assistant, 2 other */
  roles: Uint8Array;
  /** per-document trigram bloom filter */
  bloom: Uint32Array;
}

export interface ChunkRef {
  h: string; // content hash
  m: number; // message index
  s: number; // start offset in message
  e: number; // end offset in message
}

export interface SourceStatus {
  source: Source;
  state: 'idle' | 'listing' | 'fetching' | 'paused' | 'signed-out' | 'error' | 'disabled';
  message?: string;
  total?: number; // conversations known
  fetched?: number; // conversations with current content
  lastSync?: number;
  pausedUntil?: number;
  account?: string;
}

export interface Snippet {
  text: string;
  hl: [number, number][];
  role: Role;
  msgIdx: number;
  kind?: MsgKind;
  /** true when the snippet starts / ends mid-message */
  pre?: boolean;
  post?: boolean;
}

export interface SearchHit {
  id: string;
  source: Source;
  title: string;
  titleHl: [number, number][];
  url: string;
  updatedAt: number;
  createdAt: number;
  project?: string;
  model?: string;
  starred?: boolean;
  archived?: boolean;
  hits: number;
  snippets: Snippet[];
  kind: 'exact' | 'fuzzy' | 'title' | 'semantic' | 'recent';
  score: number;
  /** semantic similarity (0..1) when kind === 'semantic' */
  sim?: number;
  band?: 'strong' | 'related' | 'weak'; // semantic match quality, calibrated per embedding model
  /** content not fetched yet (title-only match) */
  pending?: boolean;
}

export interface SearchFilters {
  sources?: Source[];
  mine?: boolean; // only match in user messages
  since?: number;
  until?: number;
  starred?: boolean;
}

export interface SearchRequest {
  q: string;
  filters?: SearchFilters;
  sort?: 'best' | 'newest' | 'oldest';
  limit?: number;
  offset?: number;
  semantic?: boolean;
  qid?: number;
}

export interface SearchResponse {
  qid?: number;
  q: string;
  hits: SearchHit[];
  total: number;
  /** total is a lower bound (search was cut short) */
  more?: boolean;
  ms: number;
  /** engine still loading; results may be title-only */
  partial?: boolean;
  /** "did you mean" rewrite applied */
  corrected?: string;
  suggestion?: string;
  semantic?: { state: 'ok' | 'off' | 'indexing' | 'error'; message?: string; coverage?: number };
  terms: string[];
}

export interface Settings {
  sources: Record<Source, boolean>;
  semantic: 'off' | 'cloud' | 'local';
  includeThinking: boolean;
  includeAttachments: boolean;
  openIn: 'current' | 'new';
  iconOpens: 'popup' | 'sidepanel';
  history: boolean;
  theme: 'system' | 'light' | 'dark';
  relayUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  sources: { claude: true, chatgpt: true },
  semantic: 'local',
  includeThinking: false,
  includeAttachments: true,
  openIn: 'current',
  iconOpens: 'popup',
  history: true,
  theme: 'system',
  relayUrl: 'https://chatsearch-relay-production.up.railway.app',
};

export interface Stats {
  convs: number;
  withContent: number;
  messages: number;
  chars: number;
  vectors: number;
  vectorTarget: number;
  bySource: Record<Source, { convs: number; withContent: number }>;
  engineLoaded: boolean;
  loadMs?: number;
}
