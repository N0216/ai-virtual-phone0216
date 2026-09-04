import type { StoredCallRecord, StoredCallRecordState, StoredCallTranscriptEntry } from "./chat-db";

export type CreateCallRecordInput = Omit<StoredCallRecord, "duration" | "state" | "transcript" | "updatedAt">;
export type CallRecordStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
export type ReliableWriterOptions = {
    putRecord: (record: StoredCallRecord) => Promise<void>;
    storage?: CallRecordStorage | null;
    now?: () => string;
};

const CALL_RECORD_JOURNAL_PREFIX = "ai-phone-call-record-journal:";
const cloneTranscript = (entries: StoredCallTranscriptEntry[]) => entries.map(entry => ({ ...entry }));

function resolveStorage(): CallRecordStorage | null {
    if (typeof window === "undefined") return null;
    try { return window.localStorage; } catch { return null; }
}

const journalKey = (recordId: string) => `${CALL_RECORD_JOURNAL_PREFIX}${recordId}`;

function writeJournal(storage: CallRecordStorage | null, record: StoredCallRecord): void {
    if (!storage) return;
    try { storage.setItem(journalKey(record.id), JSON.stringify(record)); }
    catch (error) { console.warn("[CallRecord] synchronous journal failed:", error); }
}

function clearMatchingJournal(storage: CallRecordStorage | null, record: StoredCallRecord): void {
    if (!storage) return;
    try {
        const key = journalKey(record.id);
        if (storage.getItem(key) === JSON.stringify(record)) storage.removeItem(key);
    } catch (error) { console.warn("[CallRecord] journal cleanup failed:", error); }
}

function readJournalRecords(storage: CallRecordStorage | null, sessionId: string): StoredCallRecord[] {
    if (!storage) return [];
    const records: StoredCallRecord[] = [];
    try {
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (!key?.startsWith(CALL_RECORD_JOURNAL_PREFIX)) continue;
            const raw = storage.getItem(key);
            if (!raw) continue;
            const record = JSON.parse(raw) as StoredCallRecord;
            if (record?.id && record.sessionId === sessionId && Array.isArray(record.transcript)) records.push(record);
        }
    } catch (error) { console.warn("[CallRecord] journal read failed:", error); }
    return records;
}

function mergeRecordCopies(indexedDbRecords: StoredCallRecord[], journalRecords: StoredCallRecord[]): StoredCallRecord[] {
    const records = new Map<string, StoredCallRecord>();
    for (const record of [...indexedDbRecords, ...journalRecords]) {
        const existing = records.get(record.id);
        if (!existing || record.updatedAt >= existing.updatedAt) records.set(record.id, record);
    }
    return [...records.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export class ReliableCallRecordWriter {
    private record: StoredCallRecord;
    private writeQueue: Promise<void> = Promise.resolve();
    private readonly putRecord: (record: StoredCallRecord) => Promise<void>;
    private readonly storage: CallRecordStorage | null;
    private readonly now: () => string;

    constructor(input: CreateCallRecordInput, options: ReliableWriterOptions) {
        this.putRecord = options.putRecord;
        this.storage = options.storage === undefined ? resolveStorage() : options.storage;
        this.now = options.now ?? (() => new Date().toISOString());
        this.record = { ...input, duration: "", state: "ongoing", transcript: [], updatedAt: input.startedAt };
        this.queueWrite(false);
    }

    updateTranscript(transcript: StoredCallTranscriptEntry[]): void {
        this.record = { ...this.record, transcript: cloneTranscript(transcript), updatedAt: this.now() };
        this.queueWrite(false);
    }

    /** Synchronously preserves the latest partial recognition without flooding IndexedDB. */
    checkpointTranscript(transcript: StoredCallTranscriptEntry[], interimText?: string): void {
        if (this.record.state !== "ongoing") return;
        const pending = interimText?.trim();
        const entries = cloneTranscript(transcript);
        if (pending) entries.push({ id: `${this.record.id}:interim`, role: "user", content: pending, createdAt: this.now() });
        this.record = { ...this.record, transcript: entries, updatedAt: this.now() };
        writeJournal(this.storage, this.snapshot());
    }

    async finalize(
        state: Exclude<StoredCallRecordState, "ongoing">,
        duration: string,
        options?: { endedAt?: string; legacyEndMessageId?: string },
    ): Promise<void> {
        const endedAt = options?.endedAt ?? this.now();
        this.record = {
            ...this.record, state, duration, endedAt,
            legacyEndMessageId: options?.legacyEndMessageId ?? this.record.legacyEndMessageId,
            updatedAt: endedAt,
        };
        await this.queueWrite(true);
    }

    private queueWrite(reportFailure: boolean): Promise<void> {
        const snapshot = this.snapshot();
        writeJournal(this.storage, snapshot);
        const write = this.writeQueue.catch(() => undefined)
            .then(() => this.putRecord(snapshot))
            .then(() => clearMatchingJournal(this.storage, snapshot));
        this.writeQueue = write.catch(error => console.warn("[CallRecord] local persistence failed:", error));
        return reportFailure ? write : this.writeQueue;
    }

    private snapshot(): StoredCallRecord {
        return { ...this.record, transcript: cloneTranscript(this.record.transcript) };
    }
}

export async function loadReliableCallRecords(
    sessionId: string,
    options: {
        getRecords: (sessionId: string) => Promise<StoredCallRecord[]>;
        putRecord: (record: StoredCallRecord) => Promise<void>;
        storage?: CallRecordStorage | null;
    },
): Promise<StoredCallRecord[]> {
    const storage = options.storage === undefined ? resolveStorage() : options.storage;
    const journalRecords = readJournalRecords(storage, sessionId);
    let indexedDbRecords: StoredCallRecord[] = [];
    try { indexedDbRecords = await options.getRecords(sessionId); }
    catch (error) { console.warn("[CallRecord] IndexedDB read failed; using crash journal:", error); }
    for (const record of journalRecords) {
        void options.putRecord(record)
            .then(() => clearMatchingJournal(storage, record))
            .catch(error => console.warn("[CallRecord] journal recovery failed:", error));
    }
    return mergeRecordCopies(indexedDbRecords, journalRecords);
}
