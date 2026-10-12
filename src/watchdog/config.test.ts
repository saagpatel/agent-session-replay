import assert from "node:assert/strict";
import { test } from "node:test";

import { localNotificationDefaults } from "./config.ts";

test("local notification defaults use the infrastructure executable and receipt store", () => {
	assert.deepEqual(localNotificationDefaults({}, "/home/x"), {
		adapter: "/home/x/.local/bin/local-notifier",
		receipts: "/home/x/.local/share/infrastructure/notifications/receipts.sqlite3",
	});
});

test("LOCAL_NOTIFICATION_ADAPTER overrides only the adapter default", () => {
	assert.deepEqual(localNotificationDefaults({ LOCAL_NOTIFICATION_ADAPTER: "/fixture/adapter" }, "/home/x"), {
		adapter: "/fixture/adapter",
		receipts: "/home/x/.local/share/infrastructure/notifications/receipts.sqlite3",
	});
});
