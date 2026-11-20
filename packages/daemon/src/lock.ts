import { DatabaseSync } from "node:sqlite";

export function tryLock(path: string): DatabaseSync | undefined {
	const database = new DatabaseSync(path);
	try {
		database.exec("BEGIN IMMEDIATE");
		return database;
	} catch (error) {
		database.close();
		if ((error as { errcode?: number }).errcode === 5) return undefined;
		throw error;
	}
}
