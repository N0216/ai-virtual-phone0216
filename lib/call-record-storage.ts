import { dbGetCallRecordsBySession, dbPutCallRecord, type StoredCallRecord } from "./chat-db";
import {
    ReliableCallRecordWriter,
    loadReliableCallRecords,
    type CallRecordStorage,
    type CreateCallRecordInput,
    type ReliableWriterOptions,
} from "./call-record-reliability";

type LocalCallRecordWriterOptions = Omit<ReliableWriterOptions, "putRecord"> & {
    putRecord?: ReliableWriterOptions["putRecord"];
};

export class LocalCallRecordWriter extends ReliableCallRecordWriter {
    constructor(input: CreateCallRecordInput, options: LocalCallRecordWriterOptions = {}) {
        super(input, { ...options, putRecord: options.putRecord ?? dbPutCallRecord });
    }
}

export function loadLocalCallRecords(
    sessionId: string,
    options: {
        getRecords?: (sessionId: string) => Promise<StoredCallRecord[]>;
        putRecord?: (record: StoredCallRecord) => Promise<void>;
        storage?: CallRecordStorage | null;
    } = {},
): Promise<StoredCallRecord[]> {
    return loadReliableCallRecords(sessionId, {
        getRecords: options.getRecords ?? dbGetCallRecordsBySession,
        putRecord: options.putRecord ?? dbPutCallRecord,
        storage: options.storage,
    });
}
