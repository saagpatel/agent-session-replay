import { homedir } from "node:os";
import { join } from "node:path";

/** Pure defaults shared with the CLI so tests never start the live watchdog. */
export function localNotificationDefaults(
	environment: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): { adapter: string; receipts: string } {
	return {
		adapter: environment["LOCAL_NOTIFICATION_ADAPTER"] ??
			join(home, ".local", "bin", "local-notifier"),
		receipts: join(home, ".local", "share", "infrastructure", "notifications", "receipts.sqlite3"),
	};
}
