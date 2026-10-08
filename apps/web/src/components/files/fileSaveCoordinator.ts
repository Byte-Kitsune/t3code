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
  private disposed = false;
  private persistedContents: string | undefined;

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {}

  change(contents: string): void {
    if (this.disposed) return;
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

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    if (this.latestRevision > 0) void this.persistLatest();
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistLatest();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async persistLatest(): Promise<void> {
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
    const result = await this.options.persist(contents);
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
    if (this.disposed) {
      void this.persistLatest();
    } else {
      this.schedule(remainingDebounce);
    }
  }

  private confirmUnchanged(): void {
    this.confirmedRevision = this.latestRevision;
    const confirm = this.options.onUnchanged ?? this.options.onConfirmed;
    if (confirm(this.latestContents) !== false) this.options.onPendingChange(false);
  }
}
