import { describe, expect, it } from "bun:test";
import { DiscordNormalizer } from "../src/provider/discord/normalizer";
import { TelegramNormalizer } from "../src/provider/telegram/normalizer";

describe("channel normalizers", () => {
	it("maps Discord messages into ingress facts", () => {
		const message = new DiscordNormalizer().normalize(
			{
				id: "discord-in-1",
				channel_id: "dev",
				guild_id: "guild-1",
				author: { id: "seller-1", username: "Seller" },
				content: "tracking number",
				message_reference: { message_id: "discord-out-1" },
			},
		);

		expect(message).toMatchObject({
			sender: { kind: "external", surface: "discord", externalId: "seller-1" },
			facts: {
				eventId: "discord-in-1",
				surface: "discord",
				channelId: "dev",
				dm: false,
				reply: { chain: ["discord-out-1"] },
				render: "tracking number",
			},
		});
	});

	it("maps Telegram replies into ingress facts", () => {
		const message = new TelegramNormalizer({
			botId: "bot-1",
			botUsername: "openomni_bot",
		}).normalize(
			{
				message_id: 12,
				chat: { id: 34, type: "group" },
				date: 1,
				from: { id: 56, is_bot: false, first_name: "Seller" },
				text: "tracking number",
				reply_to_message: {
					message_id: 11,
					chat: { id: 34, type: "group" },
					date: 1,
					from: { id: 78, is_bot: true, first_name: "OpenOmni" },
					text: "please report",
				},
			},
		);

		expect(message).toMatchObject({
			sender: { kind: "external", surface: "telegram", externalId: "56" },
			facts: {
				eventId: "12",
				surface: "telegram",
				channelId: "34",
				dm: false,
				reply: { chain: ["11"] },
				render: "tracking number",
			},
		});
	});
});
