import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { State, privateDirectory, privateFile, pruneArtifacts } from './state.js';
import { LIMITS } from './security.js';
import { fault, publicError } from './errors.js';
import type { Verification } from './figma-adapter.js';
import { TargetQueue } from './scheduler.js';

export type Receipt = {
  jobId: string; fileKey: string; target: string; action: string;
  startedAt: string; completedAt: string; status: 'verified' | 'unverified' | 'failed' | 'indeterminate';
  beforeScreenshot?: string; afterScreenshot?: string; verification?: Verification;
  error?: { code: string; message: string };
};
export class Artifacts {
  private readonly owners = new Map<string, { session: string; created: number }>();
  private readonly writes = new TargetQueue();
  private stopping = false;
  constructor(readonly state: State) {}
  async begin(session: string): Promise<string> {
    if (this.stopping) fault('shutting_down', 'Artifact storage is closed.', 503);
    await pruneArtifacts(this.state);
    for (const [id, owner] of this.owners) if (Date.now() - owner.created > LIMITS.retentionMs) this.owners.delete(id);
    const id = `job_${randomUUID()}`;
    await this.writes.run(async () => {
      if (this.stopping) fault('shutting_down', 'Artifact storage is closed.', 503);
      if (this.owners.size >= LIMITS.artifactJobs) fault('artifact_limit', 'Artifact job capacity is full; wait for retention cleanup.', 429);
      await privateDirectory(this.state.path('artifacts', id));
      this.owners.set(id, { session, created: Date.now() });
    });
    return id;
  }
  async read(session: string, job: string, file: string): Promise<Buffer> {
    if (!/^job_[a-f0-9-]{36}$/.test(job) || !['before.png', 'after.png', 'screenshot.png', 'export.png'].includes(file)) fault('invalid_artifact', 'Invalid artifact identifier.', 400);
    const owner = this.owners.get(job);
    if (!owner || owner.session !== session || Date.now() - owner.created > LIMITS.retentionMs) fault('invalid_artifact', 'Artifact does not belong to this active session or has expired.', 404);
    const path = this.state.path('artifacts', job, file);
    await privateFile(path);
    if ((await stat(path)).size > LIMITS.artifactBytes) fault('artifact_too_large', 'Artifact exceeds the size limit.', 413);
    return readFile(path);
  }
  async image(job: string, name: 'before' | 'after' | 'screenshot' | 'export', bytes: Buffer): Promise<string> {
    if (bytes.length > LIMITS.artifactBytes) fault('artifact_too_large', 'Screenshot exceeds the artifact size limit.', 413);
    const filename = `${name}.png`;
    await this.writes.run(async () => {
      if (this.stopping) fault('shutting_down', 'Artifact storage is closed.', 503);
      const used = await pruneArtifacts(this.state);
      if (used + bytes.length > LIMITS.artifactTotalBytes) fault('artifact_quota', 'Private artifact quota is full.', 429);
      await privateFile(this.state.path('artifacts', job, filename), bytes);
    });
    return `artifacts/${job}/${filename}`;
  }
  async receipt(receipt: Receipt): Promise<Receipt> {
    // Receipt contains action names and observed booleans only, never arguments,
    // clipboard contents, form values, raw DOM or browser error strings.
    const json = JSON.stringify(receipt, null, 2) + '\n';
    if (Buffer.byteLength(json) > LIMITS.bodyBytes) fault('artifact_too_large', 'Receipt exceeds the artifact size limit.', 413);
    await this.writes.run(async () => {
      if (this.stopping) fault('shutting_down', 'Artifact storage is closed.', 503);
      const used = await pruneArtifacts(this.state);
      if (used + Buffer.byteLength(json) > LIMITS.artifactTotalBytes) fault('artifact_quota', 'Private artifact quota is full.', 429);
      await privateFile(this.state.path('artifacts', receipt.jobId, 'receipt.json'), json);
    });
    return receipt;
  }
  error(error: unknown): Receipt['error'] { return publicError(error); }
  async stop(): Promise<void> { this.stopping = true; await this.writes.drain(); }
}
