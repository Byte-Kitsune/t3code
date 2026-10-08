import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

export interface FileSaveCoordinatorOptions<A, E> {
  readonly debounceMs: number;
  readonly canPersist?: () => boolean;
  readonly persist: (contents: string) => Promise<AtomCommandResult<A, E>>;
  /** Read the disk-backed contents, without an optimistic draft overlay. */
  readonly readPersistedContents?: () => string | undefined;
  readonly onPendingChange: (pending: boolean) => void;
  /** Return false when another editor has newer unsaved contents. */
  readonly onConfirmed: (contents: string) => boolean | void;
  readonly onUnchanged?: (contents: string) => boolean | void;
}

export class FileSaveCoordinator<A = unknown, E = unknown> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private confirmedRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  private runningSave: Promise<void> | null = null;
  private disposed = false;
  private suspended = false;
  private persistedContents: string | undefined;

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {}

  change(contents: string): void {
    if (this.disposed || this.suspended) return;
    if (this.latestRevision === 0) {
      this.persistedContents = this.options.readPersistedContents?.();
    }
    if (this.latestRevision > this.confirmedRevision && contents === this.latestContents) {
      // Repeated editor events must not postpone the debounce or duplicate a write.
      // A failed write has no timer, so another event can still retry it.
      if (!this.saving && this.timer === null) this.schedule(this.options.debounceMs);
      return;
    }
    this.latestContents = contents;
    this.latestRevision += 1;
    if (!this.saving && contents === this.persistedContents) {
      this.clearTimer();
      this.confirmUnchanged();
      return;
    }
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    this.schedule(this.options.debounceMs);
  }

  suspend(): void {
    this.suspended = true;
    this.clearTimer();
  }

  resume(): void {
    if (this.disposed) return;
    this.suspended = false;
    if (this.latestRevision > this.confirmedRevision) this.schedule(this.options.debounceMs);
  }

  async waitForIdle(): Promise<void> {
    let failure: { error: unknown } | undefined;
    while (this.runningSave) {
      try {
        await this.runningSave;
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }

  async flush(): Promise<void> {
    this.clearTimer();
    await this.waitForIdle();
    this.clearTimer();
    if (this.latestRevision > this.confirmedRevision) await this.persistLatest();
    this.clearTimer();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    if (this.latestRevision > 0) void this.persistLatest().catch(() => {});
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistLatest().catch(() => {});
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private persistLatest(): Promise<void> {
    if (this.suspended) return Promise.resolve();
    if (this.runningSave) return this.runningSave;
    const revision = this.latestRevision;
    const operation = this.performPersistLatest().finally(() => {
      this.runningSave = null;
      // A retired editor must finish newer edits queued during its last write.
      if (this.disposed && this.latestRevision > revision)
        void this.persistLatest().catch(() => {});
    });
    this.runningSave = operation;
    return operation;
  }

  private async performPersistLatest(): Promise<void> {
    if (this.saving || this.latestRevision === this.confirmedRevision) return;
    if (this.latestContents === this.persistedContents) {
      this.confirmUnchanged();
      return;
    }
    if (this.options.canPersist?.() === false) {
      return;
    }

    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    let result: AtomCommandResult<A, E>;
    try {
      result = await this.options.persist(contents);
    } finally {
      this.saving = false;
    }
    const succeeded = result._tag === "Success";
    let confirmed = false;
    if (succeeded) {
      this.persistedContents = contents;
      this.confirmedRevision = revision;
      confirmed = this.options.onConfirmed(contents) !== false;
    }

    this.saving = false;
    if (revision === this.latestRevision) {
      if (confirmed) this.options.onPendingChange(false);
      return;
    }

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    );
    if (!this.disposed) {
      this.schedule(remainingDebounce);
    }
  }

  private confirmUnchanged(): void {
    this.confirmedRevision = this.latestRevision;
    const confirm = this.options.onUnchanged ?? this.options.onConfirmed;
    if (confirm(this.latestContents) !== false) this.options.onPendingChange(false);
  }
}
