export declare const name: string;
export interface SyncReport {
	created: number;
	updated: number;
	skipped: number;
	failed: string[];
	credentials: number;
}
export declare function syncOnce(...args: unknown[]): Promise<SyncReport>;
export declare function apply(ctx: unknown, rawConfig: unknown): void;
