import { pgTable, text, integer, boolean, timestamp, jsonb, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const discordUsers = pgTable("discord_users", {
  discordId: text("discord_id").primaryKey(),
  username: text("username").notNull(),
  money: integer("money").notNull().default(100),
  hp: integer("hp").notNull().default(100),
  bank: integer("bank").notNull().default(0),
  inJail: boolean("in_jail").notNull().default(false),
  jailUntil: timestamp("jail_until"),
  hasShield: boolean("has_shield").notNull().default(false),
  hasKey: boolean("has_key").notNull().default(false),
  hasGun: boolean("has_gun").notNull().default(false),
  hasPen: boolean("has_pen").notNull().default(false),
  hasStrategy: boolean("has_strategy").notNull().default(false),
  dailyLast: timestamp("daily_last"),
  govBankLast: timestamp("gov_bank_last"),
  xp: integer("xp").notNull().default(0),
  level: integer("level").notNull().default(1),
  role: text("role").notNull().default("civilian"),
  inLobby: boolean("in_lobby").notNull().default(false),
});

export const guildRegistry = pgTable("guild_registry", {
  guildId:   text("guild_id").primaryKey(),
  guildName: text("guild_name").notNull(),
  joinedAt:  timestamp("joined_at").notNull().defaultNow(),
  leftAt:    timestamp("left_at"),
  active:    boolean("active").notNull().default(true),
});

export const lobbyState = pgTable("lobby_state", {
  id: serial("id").primaryKey(),
  players: jsonb("players").notNull().default([]),
  state: text("state").notNull().default("waiting"),
  startedAt: timestamp("started_at"),
});

export const lotteryPool = pgTable("lottery_pool", {
  id: serial("id").primaryKey(),
  pool: integer("pool").notNull().default(0),
  tickets: jsonb("tickets").notNull().default({}),
  lastWinner: text("last_winner"),
  lastDraw: timestamp("last_draw"),
});

export const supportMessages = pgTable("support_messages", {
  id: serial("id").primaryKey(),
  discordId: text("discord_id").notNull(),
  username:  text("username").notNull(),
  message:   text("message").notNull(),
  read:      boolean("read").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertDiscordUserSchema = createInsertSchema(discordUsers).omit({ discordId: true });
export type InsertDiscordUser = z.infer<typeof insertDiscordUserSchema>;
export type DiscordUser = typeof discordUsers.$inferSelect;
export type LobbyState = typeof lobbyState.$inferSelect;
