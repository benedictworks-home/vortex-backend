/**
 * Archival configuration resolved from AppConfig (#413).
 */
export interface ArchivalConfig {
  /** Whether the daily archival job is enabled. */
  enabled: boolean;
  /** S3 bucket to write Parquet files and the manifest into. */
  bucketName: string;
  /** S3-compatible endpoint URL. Empty = AWS S3 default endpoint. */
  endpoint: string;
  /** AWS region. */
  region: string;
  /** AWS / MinIO access key ID. */
  accessKeyId: string;
  /** AWS / MinIO secret access key. */
  secretAccessKey: string;
  /**
   * Terminal intents (filled / cancelled / expired / slashed) older than
   * this many days are eligible for archival.
   */
  retentionDays: number;
  /**
   * S3 key prefix for the date partition.
   * Written as: `<partitionPrefix><YYYY-MM-DD>/`.
   * Default: `date=`.
   */
  partitionPrefix: string;
  /**
   * Maximum rows written to a single Parquet file before rotating.
   * Keeps individual files under ~256 MB.
   */
  maxRowsPerFile: number;
}
