export interface SequencedEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

export interface ReplaySinceResult {
  events: SequencedEvent[];
  tooOld: boolean; // true when fromSeq is older than retained history
}

export interface ReplayStore {
  append(event: SequencedEvent): Promise<void>;
  since(fromSeq: number): Promise<ReplaySinceResult>;
  latestSeq(): Promise<number>;
  oldestSeq(): Promise<number>;
}
