import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  TextChannel,
  PermissionsBitField,
} from "discord.js";
import { db } from "@workspace/db";
import { discordUsers, lobbyState, lotteryPool, supportMessages, guildRegistry } from "@workspace/db";
import { eq, desc, sql, count, sum } from "drizzle-orm";
import { logger } from "./lib/logger";

const TOKEN     = process.env["DISCORD_TOKEN"]!;
const CLIENT_ID = process.env["DISCORD_CLIENT_ID"]!;

// Module-level client reference
let botClient: Client | null = null;

// Active vote sessions: guildId → { targetId, votes: Set<voterId>, endTime }
const activeVotes = new Map<string, { targetId: string; targetName: string; yes: Set<string>; no: Set<string> }>();

// ─── Colours ───────────────────────────────────────────────────────────────────
const C = {
  green:   0x2ecc71,
  blue:    0x3498db,
  yellow:  0xf1c40f,
  orange:  0xe67e22,
  red:     0xe74c3c,
  purple:  0x9b59b6,
  teal:    0x1abc9c,
  gold:    0xf39c12,
  pink:    0xff6b9d,
  dark:    0x2c2f33,
  crimson: 0xc0392b,
};

// ─── Shop Items ────────────────────────────────────────────────────────────────
const SHOP_ITEMS = [
  {
    id: "qoryo", name: "🔫 Qoryo Qaali", price: 500, field: "hasGun",
    detail: "Hubkan qaali ah wuxuu kordhinayaa guusha dembiga (70%) iyo bangiga xasuuqista (55%). Olmadaada waa la cabsi doonaa!",
  },
  {
    id: "qalambi", name: "🖊️ Qalanbla", price: 100, field: "hasPen",
    detail: "Qalambi xeelad leh — mar kasta oo aad shaqeyso waxaad helaysaa +$15 dheeraad ah. Yar laakiin faa'iido badan!",
  },
  {
    id: "gacan", name: "🤜 Gacan Xeeladeeye", price: 300, field: "hasStrategy",
    detail: "Farsamada xadashada waxay kordhinaysaa guusha steal (70%). Gacantaadu way xeeladeysan tahay!",
  },
  {
    id: "furaha", name: "🗝️ Furaha Xabsiga", price: 200, field: "hasKey",
    detail: "Haddii la xidho, furahan wuxuu xabsiga ku xidhayaa 2 daqiiqo oo kaliya beddelkii 5. Isticmaal /bail si aad si degdeg ah ugu baxdo!",
  },
  {
    id: "gashaan", name: "🛡️ Gashaan Difaac", price: 400, field: "hasShield",
    detail: "Gashaan adag oo kaa difaacaya weerarka soo socda — robbank, arrest, ama steal. Mar keliya waa shaqeeyaa, ka dib way burburtaa.",
  },
  {
    id: "cafimaad", name: "💊 Cafimaad", price: 150, field: null,
    detail: "Dawo xoog leh oo HP-gaaga +50 u soo celisa. Haddi HP-gaagu hooseeyo waxaad ku baxaysa dagaalada!",
  },
] as const;

const JAIL_DURATION_MS     = 5 * 60 * 1000;
const JAIL_KEY_DURATION_MS = 2 * 60 * 1000;
const LOBBY_MAX             = 9;
const LOBBY_MIN             = 4;
const BOOSTER_COUNT         = 2;
const ROB_BANK_COST         = 20000;

// ─── Level Thresholds ──────────────────────────────────────────────────────────
const LEVELS = [
  { level: 1,  xp: 0    },
  { level: 2,  xp: 100  },
  { level: 3,  xp: 300  },
  { level: 4,  xp: 600  },
  { level: 5,  xp: 1000 },
  { level: 6,  xp: 1500 },
  { level: 7,  xp: 2200 },
  { level: 8,  xp: 3200 },
  { level: 9,  xp: 4500 },
  { level: 10, xp: 6000 },
];
const LEVEL_NAMES = ["","🌱 Bilow","🥉 Cusub","🥈 Dhexe","🥇 Wanaagsan","💎 Awood","🔥 Xoog","⚡ Cadaadis","🌟 Xiddig","👑 Boqor","🏆 SOMALI LEGEND"];
function getLevel(xp: number) {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (xp >= LEVELS[i]!.xp) return LEVELS[i]!.level;
  }
  return 1;
}
function nextLevelXp(lvl: number): number {
  const next = LEVELS.find(l => l.level === lvl + 1);
  return next ? next.xp : -1;
}
async function checkLevelUp(client: Client, u: typeof discordUsers.$inferSelect, newXp: number) {
  const oldLevel = u.level;
  const newLevel = getLevel(newXp);
  if (newLevel <= oldLevel) return;
  await updateUser(u.discordId, { level: newLevel });
  // Send DM congratulating level up
  try {
    const discordUser = await client.users.fetch(u.discordId);
    const next = nextLevelXp(newLevel);
    await discordUser.send({ embeds: [new EmbedBuilder()
      .setColor(C.gold)
      .setTitle(`🎉  LEVEL UP! — Heer ${newLevel}`)
      .setDescription(
        `**Hambalyo ${u.username}!** 🌟\n\n` +
        `Waxaad gaadhay **${LEVEL_NAMES[newLevel]}** — Heer **${newLevel}**!\n\n` +
        (next > 0
          ? `📊 Heerka xiga (${newLevel + 1}): **${next} XP** baad u baahan tahay\n`
          : `🏆 **WAA HEERKA UGU SARREEYA!** Adigaa guuldarada gaadhay!`
        ) +
        `\n_Sii shaqee — xoogaagana sii kordhi!_ 💪`
      )
      .addFields(
        { name: "⭐ XP Hadda",    value: `\`\`\`${newXp}\`\`\``,                   inline: true },
        { name: "🏅 Heerka Cusub", value: `\`\`\`${LEVEL_NAMES[newLevel]}\`\`\``, inline: true },
      )
      .setFooter({ text: "🤖 Somali Battle Bot — Sii Horumar!" })
      .setTimestamp()
    ] });
  } catch { /* DMs closed */ }
}

// ─── DB Helpers ────────────────────────────────────────────────────────────────
async function getOrCreateUser(id: string, username: string) {
  const [ex] = await db.select().from(discordUsers).where(eq(discordUsers.discordId, id));
  if (ex) return ex;
  await db.insert(discordUsers).values({ discordId: id, username, money: 100, hp: 100 });
  const [fresh] = await db.select().from(discordUsers).where(eq(discordUsers.discordId, id));
  return fresh!;
}
async function getUser(id: string) {
  const [u] = await db.select().from(discordUsers).where(eq(discordUsers.discordId, id));
  return u ?? null;
}
async function updateUser(id: string, vals: Partial<typeof discordUsers.$inferInsert>) {
  await db.update(discordUsers).set(vals).where(eq(discordUsers.discordId, id));
}
function isJailed(u: typeof discordUsers.$inferSelect): boolean {
  if (!u.inJail) return false;
  if (u.jailUntil && new Date() >= u.jailUntil) return false;
  return true;
}
async function releaseIfExpired(u: typeof discordUsers.$inferSelect) {
  if (u.inJail && u.jailUntil && new Date() >= u.jailUntil) {
    await updateUser(u.discordId, { inJail: false, jailUntil: null });
    return true;
  }
  return false;
}
function timeLeft(until: Date | null): string {
  if (!until) return "?";
  const ms = until.getTime() - Date.now();
  if (ms <= 0) return "dhammaaday";
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}d ${s % 60}s` : `${s}s`;
}
function isBooster(u: typeof discordUsers.$inferSelect) { return u.role === "booster"; }

// ─── DM Helper — qofka doorkooda u dir ────────────────────────────────────────
async function sendRoleDM(client: Client, discordId: string, role: "booster" | "civilian") {
  try {
    const user = await client.users.fetch(discordId);
    if (role === "booster") {
      await user.send({ embeds: [new EmbedBuilder()
        .setColor(C.gold)
        .setTitle("⚡  BOOSTER — Doorkaaga Qarsoodi!")
        .setDescription(
          "🎊 **Hambalyo!** Lobby-ga waxaad heeshay doorka **BOOSTER** !\n\n" +
          "**Faa'idooyinka Booster:**\n" +
          "• 💰 `/work` — **2× lacag** kasta oo aad kasoo qaadato\n" +
          "• 🎁 `/daily` — **2× abaalmarinta** maalinlaha\n" +
          "• 🏆 Geesinnimada ugu sareysa!\n\n" +
          "_Cidna ha u sheegin — sir baad tahay!_ 🤫"
        )
        .setFooter({ text: "🤖 Somali Battle Bot" })
        .setTimestamp()
      ] });
    } else {
      await user.send({ embeds: [new EmbedBuilder()
        .setColor(C.blue)
        .setTitle("👤  Shacab — Doorkaaga")
        .setDescription(
          "**Doorkaagu waa: 👤 Shacab**\n\n" +
          "Lobby waa bilaabatay! Si aad u guulaysato:\n" +
          "• 💼 `/work` — shaqo oo lacag kasoo qaado\n" +
          "• 🎁 `/daily` — abaalmarinta maalinlaha qaado\n" +
          "• 🏪 `/shop` — hub u iibso si aad u xoogeyso\n" +
          "• ⚔️ `/robbank` — bangi xasuuq oo lacag badan kasoo qaado!\n\n" +
          "_Xilligu waa bilaabmay — guul!_ 🎮"
        )
        .setFooter({ text: "🤖 Somali Battle Bot" })
        .setTimestamp()
      ] });
    }
  } catch {
    // User may have DMs disabled — ignore silently
  }
}

// ─── Giveaway: server walba channel-ka ugu horeysay qoraalka u dir ────────────
async function broadcastToAllGuilds(client: Client, embed: EmbedBuilder): Promise<number> {
  let sent = 0;
  for (const guild of client.guilds.cache.values()) {
    try {
      // prefer system channel, then first text channel bot can write to
      let channel: TextChannel | null = null;

      if (guild.systemChannelId) {
        const sys = guild.channels.cache.get(guild.systemChannelId);
        if (sys?.isTextBased() && sys instanceof TextChannel) {
          const perms = sys.permissionsFor(guild.members.me!);
          if (perms?.has(PermissionsBitField.Flags.SendMessages)) channel = sys;
        }
      }

      if (!channel) {
        channel = guild.channels.cache.find(
          ch =>
            ch instanceof TextChannel &&
            ch.permissionsFor(guild.members.me!)?.has(PermissionsBitField.Flags.SendMessages) === true
        ) as TextChannel | undefined ?? null;
      }

      if (channel) {
        await channel.send({ embeds: [embed] });
        sent++;
      }
    } catch {
      // skip guilds where we can't post
    }
  }
  return sent;
}

// ─── Slash Commands ────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName("start")       .setDescription("🎮 Ciyaarta bilow — profile cusub samayso"),
  new SlashCommandBuilder().setName("profile")     .setDescription("👤 Xaaladda akoonkaaga eeg")
    .addUserOption(o => o.setName("user").setDescription("Qofka aad eegeyso (ka daa si naftaada u aragto)").setRequired(false)),
  new SlashCommandBuilder().setName("work")        .setDescription("💼 Shaqo oo lacag kasoo qaado — waqti kasta isticmaal!"),
  new SlashCommandBuilder().setName("daily")       .setDescription("🎁 Abaalmarinta maalinlaha qaado — 24 saac mar"),
  new SlashCommandBuilder().setName("bank")        .setDescription("🏦 Bangigaaga maamul — lacag gali ama soo bixi")
    .addStringOption(o => o.setName("ficil").setDescription("Maxaad samaynaysaa?").setRequired(true)
      .addChoices(
        { name: "💳 Deposit — Jeebka ➜ Bangiga",   value: "deposit"  },
        { name: "💵 Withdraw — Bangiga ➜ Jeebka",  value: "withdraw" },
        { name: "📊 Balance — Xaaladda eeg",        value: "balance"  },
      ))
    .addIntegerOption(o => o.setName("lacag").setDescription("Intee lacag (deposit/withdraw kaliya)").setRequired(false).setMinValue(1)),
  new SlashCommandBuilder().setName("transfer")    .setDescription("💸 Lacag u dir qof kale")
    .addUserOption(o => o.setName("user").setDescription("Cidda lacagta dirtaa").setRequired(true))
    .addIntegerOption(o => o.setName("lacag").setDescription("Intee lacag ah").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("shop")        .setDescription("🏪 Dukaanka — alaabta oo dhan iyo sharaxaadooda eeg"),
  new SlashCommandBuilder().setName("buy")         .setDescription("🛍️ Alaab ka iibso dukaanka")
    .addStringOption(o => o.setName("alaab").setDescription("Magaca alaabta").setRequired(true)
      .addChoices(
        { name: "🔫 Qoryo Qaali       — $500",  value: "qoryo"    },
        { name: "🖊️ Qalanbla          — $100",  value: "qalambi"  },
        { name: "🤜 Gacan Xeeladeeye  — $300",  value: "gacan"    },
        { name: "🗝️ Furaha Xabsiga    — $200",  value: "furaha"   },
        { name: "🛡️ Gashaan Difaac    — $400",  value: "gashaan"  },
        { name: "💊 Cafimaad          — $150",  value: "cafimaad" },
      )),
  new SlashCommandBuilder().setName("crime")       .setDescription("🦹 Dembiga garaac — halis badan, laakiin lacag badan!"),
  new SlashCommandBuilder().setName("robbank")     .setDescription("🏦💣 Bangiga qof kale xasuuq — qarax $20,000 kharash!")
    .addUserOption(o => o.setName("user").setDescription("Cidda bangigeedu xasuuqayso").setRequired(true)),
  new SlashCommandBuilder().setName("steal")       .setDescription("🤏 Lacag yar si xillig ah qof kale ka xad")
    .addUserOption(o => o.setName("user").setDescription("Cidda xadanayso").setRequired(true)),
  new SlashCommandBuilder().setName("fright")      .setDescription("👻 Qof kale cabsi rid oo lacag jeebkiisa ka daadi")
    .addUserOption(o => o.setName("user").setDescription("Cidda cabanayso").setRequired(true)),
  new SlashCommandBuilder().setName("arrest")      .setDescription("👮 Qof kale xabsi geli (60% guul)")
    .addUserOption(o => o.setName("user").setDescription("Cidda xabsiga gelisa").setRequired(true)),
  new SlashCommandBuilder().setName("bail")        .setDescription("🔓 Xabsiga ka bixi — $50 bixin ama furaha xabsiga isticmaal"),
  new SlashCommandBuilder().setName("duel")        .setDescription("⚔️ Tartam lacag leh qof kale — mid keliya ayaa guuleysta!")
    .addUserOption(o => o.setName("user").setDescription("Cidda aad tartanayso").setRequired(true))
    .addIntegerOption(o => o.setName("lacag").setDescription("Intee lacag aad tartanayso").setRequired(true).setMinValue(10)),
  new SlashCommandBuilder().setName("lottery")     .setDescription("🎰 Lottery ticket iibso — 20 ticket marka la gaadhaa jackpot!")
    .addIntegerOption(o => o.setName("tickets").setDescription("Tikerrada tirada (1-10)").setRequired(true).setMinValue(1).setMaxValue(10)),
  new SlashCommandBuilder().setName("leaderboard") .setDescription("🏆 Ugu hodanta 10 ciyaartoyda eeg"),
  new SlashCommandBuilder().setName("status")      .setDescription("📊 Ciyaarta xaaladdeeda guud — tirooyinka, jackpot, lobby"),
  new SlashCommandBuilder().setName("join")        .setDescription("🚪 Lobby ku biir — 9 qof marka la buuxo ciyaartu bilaabataa"),
  new SlashCommandBuilder().setName("lobby")       .setDescription("🎮 Lobby xaaladda hadda eeg — cidda ku jirta iyo tirada"),
  new SlashCommandBuilder().setName("help")        .setDescription("📖 Amarrada oo dhan — sharaxaad faahfaahsan"),
  new SlashCommandBuilder().setName("gamble")       .setDescription("🎲 Lacag ku ciyaar — %50 guul, %50 qasaaro!")
    .addIntegerOption(o => o.setName("lacag").setDescription("Intee lacag aad ciyaarayso").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("vote")         .setDescription("🗳️ Lobby ku jira qof ka saari — cod badan ayaa go'aaminaya")
    .addUserOption(o => o.setName("user").setDescription("Cidda aad u codeynayso in la saaro").setRequired(true)),
  new SlashCommandBuilder().setName("resetlobby")  .setDescription("🔄 Lobby dib u bilow — ciyaartii hore tirtir si cusub loo bilaabo"),
  new SlashCommandBuilder().setName("caawi")       .setDescription("📩 Fariin toos ah ii soo dir — su'aal, problem, ama talo")
    .addStringOption(o => o.setName("fariin").setDescription("Qoraalka aad ii soo direyso").setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName("servers")     .setDescription("🌐 [Admin] Bot ku jiro servers-ka database-ka laga helay oo dhan eeg"),
  new SlashCommandBuilder().setName("ban")         .setDescription("🚫 [Admin] Replit DB isticmaal si aad qof u maamusho"),
  new SlashCommandBuilder().setName("govbank")     .setDescription("🏛️ Bank Dowlada — maalin kasta $300 qaado"),
].map(c => c.toJSON());

// ─── Register ──────────────────────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    logger.info("✅ Discord commands registered");
  } catch (err) { logger.error({ err }, "Failed to register commands"); }
}

async function ensureLobby() {
  const rows = await db.select().from(lobbyState);
  if (!rows.length) await db.insert(lobbyState).values({ players: [], state: "waiting" });
}
async function ensureLottery() {
  const rows = await db.select().from(lotteryPool);
  if (!rows.length) await db.insert(lotteryPool).values({ pool: 0, tickets: {} });
}

// ─── /start ────────────────────────────────────────────────────────────────────
async function handleStart(i: ChatInputCommandInteraction) {
  const u = await getUser(i.user.id);
  if (u) return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.orange)
    .setDescription("⚠️ **Horey ayaad bilaabatay!** `/profile` isticmaal si aad xaaladda u aragto.")
  ], ephemeral: true });

  await getOrCreateUser(i.user.id, i.user.username);

  const embed = new EmbedBuilder()
    .setColor(C.green)
    .setTitle("🎮  Ciyaarta waa Bilaabatay!")
    .setDescription(`✨ Ku soo dhawoow **${i.user.username}**!\nProfile cusub oo xoog leh ayaa laguu sameeyay.`)
    .addFields(
      { name: "💰 Jeebka",   value: "```$100```", inline: true },
      { name: "❤️ HP",      value: "```100```",   inline: true },
      { name: "🏦 Bangiga",  value: "```$0```",   inline: true },
      { name: "🎭 Doorkaaga", value: "👤 **Shacab** (lobby ka biir si doorka booster u hesho!)", inline: false },
    )
    .setThumbnail(i.user.displayAvatarURL())
    .setFooter({ text: "💡 /help amarrada • /work lacag • /shop dukaanka • /join lobby" })
    .setTimestamp();

  await i.reply({ embeds: [embed] });

  // DM the new player their starting role
  try {
    await i.user.send({ embeds: [new EmbedBuilder()
      .setColor(C.blue)
      .setTitle("👤  Ciyaarta Waa Bilaabatay — DM!")
      .setDescription(
        `Ku soo dhawoow **Somali Battle**, **${i.user.username}**! 🎮\n\n` +
        "**Doorkaagu hadda waa: 👤 Shacab**\n\n" +
        "**Amarrada Muhiimka ah:**\n" +
        "• 💼 `/work` — Shaqo oo lacag kasoo qaado\n" +
        "• 🎁 `/daily` — Abaalmarinta maalinlaha (24h mar)\n" +
        "• 🏪 `/shop` — Alaab iibso si aad u xoogeyso\n" +
        "• 🚪 `/join` — Lobby ku biir (9 qof — 2 Booster!)\n" +
        "• 📖 `/help` — Amarrada oo dhan\n\n" +
        "_Guul iyo barwaaqo! Ciyaarta waa aad u macaan!_ ⚔️"
      )
      .setFooter({ text: "🤖 Somali Battle Bot" })
      .setTimestamp()
    ] });
  } catch { /* DMs off — skip */ }
}

// ─── /profile ─────────────────────────────────────────────────────────────────
async function handleProfile(i: ChatInputCommandInteraction) {
  const target = i.options.getUser("user") ?? i.user;
  const u = await getUser(target.id);
  if (!u) return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.red)
    .setDescription(`❌ **${target.username}** ciyaarta ma bilaabo! \`/start\` ha isticmaalo.`)
  ], ephemeral: true });

  await releaseIfExpired(u);
  const f = (await getUser(u.discordId))!;
  const jailTxt  = isJailed(f) ? `🔒 Xabsi — ⏳ **${timeLeft(f.jailUntil)}**` : "🟢 Xor";
  const roleTxt  = f.role === "booster" ? "⚡ Booster (2x lacag)" : "👤 Shacab";
  const itemList = [
    f.hasGun      ? "🔫 Qoryo"   : null,
    f.hasPen      ? "🖊️ Qalambi" : null,
    f.hasStrategy ? "🤜 Gacan"   : null,
    f.hasKey      ? "🗝️ Furaha"  : null,
    f.hasShield   ? "🛡️ Gashaan" : null,
  ].filter(Boolean).join("  ") || "_(waxba)_";
  const hpBar = "🟩".repeat(Math.round(f.hp / 10)) + "⬛".repeat(10 - Math.round(f.hp / 10));

  return i.reply({ embeds: [new EmbedBuilder()
    .setColor(f.role === "booster" ? C.gold : C.blue)
    .setTitle(`👤  ${target.username}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: "💰 Jeebka",              value: `\`\`\`$${f.money}\`\`\``,          inline: true  },
      { name: "🏦 Bangiga",             value: `\`\`\`$${f.bank}\`\`\``,           inline: true  },
      { name: "📦 Wadarta",             value: `\`\`\`$${f.money + f.bank}\`\`\``, inline: true  },
      { name: `❤️ HP  (${f.hp}/100)`,  value: hpBar,                               inline: false },
      { name: "⭐ XP",                  value: `**${f.xp}**`,                                                              inline: true  },
      { name: "🏅 Heer",               value: `**${f.level}** — ${LEVEL_NAMES[f.level] ?? "?"}`,                         inline: true  },
      { name: "📈 Heer Xiga",          value: nextLevelXp(f.level) > 0 ? `**${nextLevelXp(f.level)} XP**` : "MAX ✅",    inline: true  },
      { name: "🎭 Doorka",              value: roleTxt,                                                                    inline: true  },
      { name: "🔒 Xaaladda",            value: jailTxt,                                                                    inline: true  },
      { name: "🎒 Alaabta",             value: itemList,                                                                   inline: false },
    )
    .setTimestamp()
  ] });
}

// ─── /work ────────────────────────────────────────────────────────────────────
async function handleWork(i: ChatInputCommandInteraction) {
  const u = await getOrCreateUser(i.user.id, i.user.username);
  await releaseIfExpired(u);
  const f = (await getUser(u.discordId))!;

  if (isJailed(f)) return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.crimson)
    .setTitle("🔒  Xabsi Baad Ku Jirtaa!")
    .setDescription("Xidhan baad tahay — ma shaqaysan kartid!\nIsticmaal `/bail` si aad xor u noqoto.")
    .addFields({ name: "⏳ Waqti haray", value: `**${timeLeft(f.jailUntil)}**`, inline: true })
  ], ephemeral: true });

  const base     = Math.floor(Math.random() * 50) + 10;
  const bonus    = f.hasPen ? 15 : 0;
  const earn     = isBooster(f) ? (base + bonus) * 2 : base + bonus;
  const newMoney = f.money + earn;
  const newXp    = f.xp + 5;
  await updateUser(u.discordId, { money: newMoney, xp: newXp });
  if (botClient) await checkLevelUp(botClient, f, newXp);

  const jobs = [
    { emoji: "🔨", name: "Dhismaha" },     { emoji: "🚗", name: "Koobi qaadista" },
    { emoji: "🛒", name: "Suuqa ganacsiga" }, { emoji: "🍕", name: "Pizza gaarsiinta" },
    { emoji: "💻", name: "Code qorista" }, { emoji: "🔧", name: "Baabuurta hagaajinta" },
    { emoji: "📦", name: "Alaabta keenista" }, { emoji: "🎨", name: "Sawirka naqshadaynta" },
  ];
  const job = jobs[Math.floor(Math.random() * jobs.length)]!;

  const embed = new EmbedBuilder()
    .setColor(C.green)
    .setTitle(`${job.emoji}  Shaqadii Way Dhamatay!`)
    .setDescription(`Waxaad ka shaqeysay **${job.name}** — shaqo wanaagsan! 💪`)
    .addFields(
      { name: "💵 Lacagta aad heshay", value: `\`\`\`+ $${earn}\`\`\``,  inline: true },
      { name: "💰 Jeebka hadda",       value: `\`\`\`$${newMoney}\`\`\``, inline: true },
      { name: "⭐ XP",                 value: `\`\`\`+ 5\`\`\``,          inline: true },
    );
  if (isBooster(f)) embed.addFields({ name: "⚡ Booster Bonus!", value: "2× lacag — aad baad u xoog leedahay!", inline: false });
  if (f.hasPen)     embed.addFields({ name: "🖊️ Qalambi Bonus",  value: "+$15 dheeraad ah",                    inline: false });
  embed.setFooter({ text: "Waqti badan shaqo — lacag badan kasoo qaad!" }).setTimestamp();
  return i.reply({ embeds: [embed] });
}

// ─── /daily ───────────────────────────────────────────────────────────────────
async function handleDaily(i: ChatInputCommandInteraction) {
  const u   = await getOrCreateUser(i.user.id, i.user.username);
  const now = new Date();

  if (u.dailyLast) {
    const diff = now.getTime() - u.dailyLast.getTime();
    if (diff < 24 * 60 * 60 * 1000) {
      const rem = 24 * 60 * 60 * 1000 - diff;
      const h   = Math.floor(rem / 3600000);
      const m   = Math.floor((rem % 3600000) / 60000);
      return i.reply({ embeds: [new EmbedBuilder()
        .setColor(C.orange)
        .setTitle("⏳  Maanta Horey Ayaad Qaadday!")
        .setDescription(`Ku soo noqo **${h}h ${m}m** gudahood si aad abaalmarinta u qaadato.`)
      ], ephemeral: true });
    }
  }

  const reward   = isBooster(u) ? 400 : 200;
  const newMoney = u.money + reward;
  const newXpD   = u.xp + 20;
  await updateUser(u.discordId, { money: newMoney, dailyLast: now, xp: newXpD });
  if (botClient) await checkLevelUp(botClient, u, newXpD);

  const greets = [
    "Maanta waa maalin fiican! 🌟", "Gacantaada hel abaalmarintaada! 🎊",
    "Maalin kasta lacag — nolol fiican! 💫", "Abaalmarintii maanta waa tan! 🎉",
  ];
  const embed = new EmbedBuilder()
    .setColor(C.yellow)
    .setTitle("🎁  Abaalmarinta Maalinlaha!")
    .setDescription(greets[Math.floor(Math.random() * greets.length)]!)
    .addFields(
      { name: "💵 Lacagta aad heshay", value: `\`\`\`+ $${reward}\`\`\``,  inline: true },
      { name: "💰 Jeebka hadda",       value: `\`\`\`$${newMoney}\`\`\``, inline: true },
      { name: "⭐ XP",                 value: `\`\`\`+ 20\`\`\``,          inline: true },
    );
  if (isBooster(u)) embed.addFields({ name: "⚡ Booster!", value: "2× abaalmarinta — adigaa xoog badan!", inline: false });
  embed.setFooter({ text: "Berri dib u kaalay — abaalmarinta kale qaado!" }).setTimestamp();
  return i.reply({ embeds: [embed] });
}

// ─── /bank ────────────────────────────────────────────────────────────────────
async function handleBank(i: ChatInputCommandInteraction) {
  const u     = await getOrCreateUser(i.user.id, i.user.username);
  const ficil = i.options.getString("ficil", true);
  const lacag = i.options.getInteger("lacag") ?? 0;

  if (ficil === "balance") {
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.teal).setTitle("🏦  Bangigaaga")
      .addFields(
        { name: "💰 Jeebka",  value: `\`\`\`$${u.money}\`\`\``,          inline: true },
        { name: "🏦 Bangiga", value: `\`\`\`$${u.bank}\`\`\``,           inline: true },
        { name: "📊 Wadarta", value: `\`\`\`$${u.money + u.bank}\`\`\``, inline: true },
      ).setTimestamp()
    ] });
  }
  if (ficil === "deposit") {
    if (!lacag)         return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ Lacag tiro sax ah geli!")], ephemeral: true });
    if (lacag > u.money) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ Jeebka lacag kuma filan! Jeebka: **$${u.money}**`)], ephemeral: true });
    await updateUser(u.discordId, { money: u.money - lacag, bank: u.bank + lacag });
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.teal).setTitle("🏦  Bank Deposit!")
      .addFields(
        { name: "💳 La gashaday",  value: `\`\`\`$${lacag}\`\`\``,          inline: true },
        { name: "🏦 Bangiga",      value: `\`\`\`$${u.bank + lacag}\`\`\``, inline: true },
        { name: "💰 Jeebka haray", value: `\`\`\`$${u.money - lacag}\`\`\``, inline: true },
      ).setTimestamp()
    ] });
  }
  if (ficil === "withdraw") {
    if (!lacag)        return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ Lacag tiro sax ah geli!")], ephemeral: true });
    if (lacag > u.bank) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ Bangiga lacag kuma filan! Bangiga: **$${u.bank}**`)], ephemeral: true });
    await updateUser(u.discordId, { money: u.money + lacag, bank: u.bank - lacag });
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.teal).setTitle("🏦  Bank Withdrawal!")
      .addFields(
        { name: "💵 La soo bixiyay", value: `\`\`\`$${lacag}\`\`\``,          inline: true },
        { name: "💰 Jeebka",         value: `\`\`\`$${u.money + lacag}\`\`\``, inline: true },
        { name: "🏦 Bangiga haray",  value: `\`\`\`$${u.bank - lacag}\`\`\``,  inline: true },
      ).setTimestamp()
    ] });
  }
}

// ─── /transfer ────────────────────────────────────────────────────────────────
async function handleTransfer(i: ChatInputCommandInteraction) {
  const u      = await getOrCreateUser(i.user.id, i.user.username);
  const target = i.options.getUser("user", true);
  const lacag  = i.options.getInteger("lacag", true);
  if (target.id === i.user.id) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ Naftaada lacag u diri kartid!")], ephemeral: true });
  if (lacag > u.money)         return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ Jeebka lacag kuma filan! Jeebka: **$${u.money}**`)], ephemeral: true });
  const t = await getUser(target.id);
  if (!t) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ **${target.username}** ciyaarta ma bilaabo!`)], ephemeral: true });
  await updateUser(u.discordId, { money: u.money - lacag });
  await updateUser(t.discordId, { money: t.money + lacag });
  return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.teal).setTitle("💸  Transfer Guuleyso!")
    .setDescription(`**$${lacag}** waxaa loo diray **${target.username}** ✅`)
    .addFields(
      { name: "💰 Jeebkaaga hadda", value: `\`\`\`$${u.money - lacag}\`\`\``, inline: true },
      { name: "🎯 Cidda la diray",  value: `**${target.username}**`,           inline: true },
    ).setTimestamp()
  ] });
}

// ─── /shop ────────────────────────────────────────────────────────────────────
async function handleShop(i: ChatInputCommandInteraction) {
  const u     = await getOrCreateUser(i.user.id, i.user.username);
  const embed = new EmbedBuilder()
    .setColor(C.gold)
    .setTitle("🏪  Dukaanka — Alaabta Oo Dhan")
    .setDescription(`💰 **Jeebkaaga:** \`$${u.money}\`\n\nAlaab kasta iibso: \`/buy <magaca>\`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  for (const item of SHOP_ITEMS) {
    const owned = item.field ? u[item.field as keyof typeof u] : false;
    const label = owned ? " ✅ _(lahayd)_" : "";
    embed.addFields({ name: `${item.name}  —  💲$${item.price}${label}`, value: `> ${item.detail}`, inline: false });
  }
  embed.setFooter({ text: "🛍️ /buy <magaca>  |  Tusaale: /buy qoryo" }).setTimestamp();
  return i.reply({ embeds: [embed] });
}

// ─── /buy ─────────────────────────────────────────────────────────────────────
async function handleBuy(i: ChatInputCommandInteraction) {
  const u    = await getOrCreateUser(i.user.id, i.user.username);
  const id   = i.options.getString("alaab", true);
  const item = SHOP_ITEMS.find(s => s.id === id);
  if (!item) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ Alaab la mid ah lama helin!")], ephemeral: true });
  if (u.money < item.price) return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.red).setDescription(`❌ **Lacag kuma filan!**\n💰 Jeebka: **$${u.money}** | Qiimaha: **$${item.price}**`)
  ], ephemeral: true });

  if (id === "cafimaad") {
    const newHp = Math.min(100, u.hp + 50);
    await updateUser(u.discordId, { money: u.money - item.price, hp: newHp });
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.green).setTitle("💊  Cafimaad La Iibsaday!")
      .addFields(
        { name: "❤️ HP",           value: `**${u.hp}** ➜ **${newHp}**`,         inline: true },
        { name: "💰 Jeebka haray", value: `\`\`\`$${u.money - item.price}\`\`\``, inline: true },
      ).setTimestamp()
    ] });
  }

  const fieldMap: Record<string, keyof typeof discordUsers.$inferInsert> = {
    qoryo: "hasGun", qalambi: "hasPen", gacan: "hasStrategy", furaha: "hasKey", gashaan: "hasShield",
  };
  const field = fieldMap[id];
  if (!field) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ Khalad ah!")], ephemeral: true });
  if (u[field as keyof typeof u]) return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.orange).setDescription(`⚠️ **${item.name}** horey ayaad u lahayd!`)
  ], ephemeral: true });

  await updateUser(u.discordId, { money: u.money - item.price, [field]: true });
  return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.green).setTitle(`✅  ${item.name} — La Iibsaday!`)
    .setDescription(`> ${item.detail}`)
    .addFields({ name: "💰 Jeebka haray", value: `\`\`\`$${u.money - item.price}\`\`\``, inline: true })
    .setTimestamp()
  ] });
}

// ─── /crime ───────────────────────────────────────────────────────────────────
async function handleCrime(i: ChatInputCommandInteraction) {
  const u = await getOrCreateUser(i.user.id, i.user.username);
  await releaseIfExpired(u);
  const f = (await getUser(u.discordId))!;
  if (isJailed(f)) return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.crimson).setTitle("🔒  Xabsi Baad Ku Jirtaa!")
    .setDescription(`Ma dembiyeyn kartid. Waqti: **${timeLeft(f.jailUntil)}**`)
  ], ephemeral: true });

  if (Math.random() < (f.hasGun ? 0.70 : 0.50)) {
    const earn     = isBooster(f) ? (Math.floor(Math.random() * 150) + 50) * 2 : Math.floor(Math.random() * 150) + 50;
    const newMoney = f.money + earn;
    await updateUser(u.discordId, { money: newMoney, xp: f.xp + 15 });
    const sc = [
      { e: "🏪", t: "Dukaanka la xasuuqay" }, { e: "🚙", t: "Baabuur la xadday" },
      { e: "💎", t: "Dahab la xadday" },      { e: "🏧", t: "ATM la jabay" },
    ][Math.floor(Math.random() * 4)]!;
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.green).setTitle(`${sc.e}  Dembi Guuleyso!`)
      .setDescription(`**${sc.t}** — cidna kama gaanin! 😈`)
      .addFields(
        { name: "💵 Lacagta heshay", value: `\`\`\`+ $${earn}\`\`\``,   inline: true },
        { name: "💰 Jeebka hadda",   value: `\`\`\`$${newMoney}\`\`\``, inline: true },
        { name: "⭐ XP",             value: `\`\`\`+ 15\`\`\``,          inline: true },
      ).setFooter({ text: f.hasGun ? "🔫 Hub wuxuu fududeeyay dembiga!" : "💡 /buy qoryo — guul badan!" }).setTimestamp()
    ] });
  } else {
    const fine      = Math.floor(Math.random() * 50) + 20;
    const jailUntil = new Date(Date.now() + JAIL_DURATION_MS);
    await updateUser(u.discordId, { money: Math.max(0, f.money - fine), inJail: true, jailUntil });
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.crimson).setTitle("👮  Baabuurtu Way Ku Qabatay!")
      .setDescription("Dembigaagu waa la ogaaday — xabsi ayaad taqtay! 🚨")
      .addFields(
        { name: "💸 Ganaax",       value: `\`\`\`- $${fine}\`\`\``, inline: true },
        { name: "⏳ Xabsi",        value: `\`\`\`5 daqiiqo\`\`\``,   inline: true },
      ).setFooter({ text: "💡 /bail isticmaal si aad u baxdo!" }).setTimestamp()
    ] });
  }
}

// ─── /robbank ─────────────────────────────────────────────────────────────────
async function handleRobBank(i: ChatInputCommandInteraction) {
  const u = await getOrCreateUser(i.user.id, i.user.username);
  await releaseIfExpired(u);
  const f = (await getUser(u.discordId))!;

  if (isJailed(f))          return i.reply({ embeds: [new EmbedBuilder().setColor(C.crimson).setDescription("🔒 **Xabsi baad ku jirtaa!** Ma xasuuqi kartid.")], ephemeral: true });
  if (f.money < ROB_BANK_COST) return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.red).setTitle("💣  Lacag Kuma Filan Qaraxda!")
    .setDescription(`Bangiga xasuuqista waxay u baahan tahay **$${ROB_BANK_COST.toLocaleString()}** qarax!\n💰 Jeebka hadda: **$${f.money.toLocaleString()}**`)
  ], ephemeral: true });

  const target = i.options.getUser("user", true);
  if (target.id === i.user.id) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ Naftaada bangiga ma xasuuqi kartid!")], ephemeral: true });
  const t = await getUser(target.id);
  if (!t)          return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ **${target.username}** ciyaarta ma bilaabo!`)], ephemeral: true });
  if (t.bank < 100) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ **${target.username}** bangiga lacag kuma filan! (Bangiga: $${t.bank})`)], ephemeral: true });

  await updateUser(u.discordId, { money: f.money - ROB_BANK_COST });
  const updatedU = (await getUser(u.discordId))!;

  if (t.hasShield) {
    await updateUser(t.discordId, { hasShield: false });
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.orange).setTitle("🛡️  Gashaan Waa La Xannibay!")
      .setDescription(`**${target.username}** bangigii Gashaan ayaa difaacay!\n💣 Waxaad lumisay **$${ROB_BANK_COST.toLocaleString()}** qarax lacag!`)
      .setTimestamp()
    ] });
  }

  if (Math.random() < (f.hasGun ? 0.55 : 0.35)) {
    const pct   = 0.3 + Math.random() * 0.4;
    const steal = Math.min(t.bank, Math.floor(t.bank * pct));
    await updateUser(t.discordId, { bank: t.bank - steal });
    await updateUser(u.discordId, { money: updatedU.money + steal, xp: f.xp + 50 });
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.green).setTitle("🏦💣  Bangiga Xasuuq Guuleyso!")
      .setDescription(`🎆 **${target.username}** bangigii waa la qarxiyay!`)
      .addFields(
        { name: "💵 Bangiga ka la xadday", value: `\`\`\`+ $${steal.toLocaleString()}\`\`\``,                inline: true },
        { name: "💰 Jeebka hadda",         value: `\`\`\`$${(updatedU.money + steal).toLocaleString()}\`\`\``, inline: true },
        { name: "⭐ XP",                   value: `\`\`\`+ 50\`\`\``,                                          inline: true },
        { name: "💣 Qarax kharash",        value: `$${ROB_BANK_COST.toLocaleString()}`,                        inline: true },
      ).setFooter({ text: "🏆 Bank rob — aad ayuu u haliste laakiin faa'iidadu weyn!" }).setTimestamp()
    ] });
  } else {
    const fine      = Math.floor(Math.random() * 2000) + 1000;
    const jailUntil = new Date(Date.now() + JAIL_DURATION_MS);
    await updateUser(u.discordId, { money: Math.max(0, updatedU.money - fine), inJail: true, jailUntil });
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.crimson).setTitle("👮🏦  Bangiga Waa La Ku Qabtay!")
      .setDescription(`Boolisku way kuu soo jiifeen! 🚨\n_Marka xigta hub ka fiirso!_`)
      .addFields(
        { name: "💸 Ganaax",        value: `\`\`\`- $${fine.toLocaleString()}\`\`\``,          inline: true },
        { name: "💣 Qarax kharash", value: `\`\`\`- $${ROB_BANK_COST.toLocaleString()}\`\`\``, inline: true },
        { name: "⏳ Xabsi",         value: `\`\`\`5 daqiiqo\`\`\``,                             inline: true },
      ).setFooter({ text: "💡 /bail isticmaal si aad u baxdo!" }).setTimestamp()
    ] });
  }
}

// ─── /steal ───────────────────────────────────────────────────────────────────
async function handleSteal(i: ChatInputCommandInteraction) {
  const u = await getOrCreateUser(i.user.id, i.user.username);
  await releaseIfExpired(u);
  const f = (await getUser(u.discordId))!;
  if (isJailed(f)) return i.reply({ embeds: [new EmbedBuilder().setColor(C.crimson).setDescription("🔒 **Xabsi baad ku jirtaa!** Ma xadi kartid.")], ephemeral: true });
  const target = i.options.getUser("user", true);
  if (target.id === i.user.id) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ Naftaada ma xadi kartid!")], ephemeral: true });
  const t = await getUser(target.id);
  if (!t || t.money < 5) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ **${target.username}** jeeb lacag kuma filan!`)], ephemeral: true });
  if (t.hasShield) {
    await updateUser(t.discordId, { hasShield: false });
    return i.reply({ embeds: [new EmbedBuilder().setColor(C.orange).setTitle("🛡️  Gashaan!").setDescription(`**${target.username}** Gashaan ayuu lahaa — xadashadu waa la xannibay!`).setTimestamp()] });
  }
  if (Math.random() < (f.hasStrategy ? 0.70 : 0.50)) {
    const amount = Math.min(t.money, Math.floor(Math.random() * 40) + 5);
    await updateUser(t.discordId, { money: t.money - amount });
    await updateUser(u.discordId, { money: f.money + amount, xp: f.xp + 10 });
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.green).setTitle("🤏  Xadashada Guuleyso!")
      .addFields(
        { name: "💵 Lacagta heshay", value: `\`\`\`+ $${amount}\`\`\``,        inline: true },
        { name: "💰 Jeebka hadda",   value: `\`\`\`$${f.money + amount}\`\`\``, inline: true },
        { name: "⭐ XP",             value: `\`\`\`+ 10\`\`\``,                 inline: true },
      ).setTimestamp()
    ] });
  } else {
    const fine = Math.floor(Math.random() * 20) + 10;
    await updateUser(u.discordId, { money: Math.max(0, f.money - fine) });
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.crimson).setTitle("👮  Xadashadu Waa Ku Dhacday!")
      .addFields({ name: "💸 Ganaax", value: `\`\`\`- $${fine}\`\`\``, inline: true })
      .setTimestamp()
    ] });
  }
}

// ─── /fright ──────────────────────────────────────────────────────────────────
async function handleFright(i: ChatInputCommandInteraction) {
  const u = await getOrCreateUser(i.user.id, i.user.username);
  await releaseIfExpired(u);
  const f = (await getUser(u.discordId))!;
  if (isJailed(f)) return i.reply({ embeds: [new EmbedBuilder().setColor(C.crimson).setDescription("🔒 **Xabsi baad ku jirtaa!** Ma cabsan kartid.")], ephemeral: true });
  const target = i.options.getUser("user", true);
  if (target.id === i.user.id) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ Naftaada ma cabsan kartid!")], ephemeral: true });
  const t = await getUser(target.id);
  if (!t) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ **${target.username}** ciyaarta ma bilaabo!`)], ephemeral: true });
  const icons = ["👻","😱","💀","🕷️","🦇","🎃","🤡"];
  const icon  = icons[Math.floor(Math.random() * icons.length)]!;
  if (Math.random() < 0.60) {
    const amount = Math.min(t.money, Math.floor(Math.random() * 30) + 5);
    await updateUser(t.discordId, { money: t.money - amount });
    await updateUser(u.discordId, { money: f.money + amount });
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.purple).setTitle(`${icon}  Cabsi Rid Guuleyso!`)
      .setDescription(`**${target.username}** waa cabsaday — jeebka ayuu daatay! 😂`)
      .addFields({ name: "💰 Lacagta heshay", value: `\`\`\`+ $${amount}\`\`\``, inline: true })
      .setTimestamp()
    ] });
  } else {
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.orange).setTitle(`${icon}  Cabsidu Waa Ku Dhacday!`)
      .setDescription(`**${target.username}** kama cabsan! 😅 Cabsida waa iska qososhay.`)
      .setTimestamp()
    ] });
  }
}

// ─── /arrest ──────────────────────────────────────────────────────────────────
async function handleArrest(i: ChatInputCommandInteraction) {
  const u = await getOrCreateUser(i.user.id, i.user.username);
  await releaseIfExpired(u);
  const f = (await getUser(u.discordId))!;
  if (isJailed(f)) return i.reply({ embeds: [new EmbedBuilder().setColor(C.crimson).setDescription("🔒 **Xabsi baad ku jirtaa!** Qof kale ma gelin kartid.")], ephemeral: true });
  const target = i.options.getUser("user", true);
  if (target.id === i.user.id) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ Naftaada ma xidhi kartid!")], ephemeral: true });
  const t = await getUser(target.id);
  if (!t) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ **${target.username}** ciyaarta ma bilaabo!`)], ephemeral: true });
  if (isJailed(t)) return i.reply({ embeds: [new EmbedBuilder().setColor(C.orange).setDescription(`🔒 **${target.username}** horaa xabsiga ku jira!`)], ephemeral: true });
  if (t.hasShield) {
    await updateUser(t.discordId, { hasShield: false });
    return i.reply({ embeds: [new EmbedBuilder().setColor(C.orange).setTitle("🛡️  Gashaan!").setDescription(`**${target.username}** Gashaan ayuu lahaa — xididhkii waa la xannibay!`).setTimestamp()] });
  }
  if (Math.random() < 0.60) {
    const duration  = t.hasKey ? JAIL_KEY_DURATION_MS : JAIL_DURATION_MS;
    const jailUntil = new Date(Date.now() + duration);
    await updateUser(t.discordId, { inJail: true, jailUntil });
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.blue).setTitle("👮  Arrest Guuleyso!")
      .setDescription(`🔒 **${target.username}** xabsiga waa la galiyay!`)
      .addFields({ name: "⏳ Xabsi waqti", value: `\`\`\`${t.hasKey ? "2 daqiiqo (furaha waa la isticmaalay)" : "5 daqiiqo"}\`\`\``, inline: false })
      .setTimestamp()
    ] });
  } else {
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.orange).setTitle("👮  Arrest Waa Ku Dhacday!")
      .setDescription(`🏃 **${target.username}** ayaa cararay — ma la qabsan karin!`)
      .setTimestamp()
    ] });
  }
}

// ─── /bail ────────────────────────────────────────────────────────────────────
async function handleBail(i: ChatInputCommandInteraction) {
  const u = await getOrCreateUser(i.user.id, i.user.username);
  await releaseIfExpired(u);
  const f = (await getUser(u.discordId))!;
  if (!f.inJail) return i.reply({ embeds: [new EmbedBuilder().setColor(C.green).setDescription("✅ Xor baad tahay — xabsiga ku jirto!")], ephemeral: true });
  if (f.jailUntil && new Date() >= f.jailUntil) {
    await updateUser(u.discordId, { inJail: false, jailUntil: null });
    return i.reply({ embeds: [new EmbedBuilder().setColor(C.green).setTitle("🔓  Waqtigu Dhammaaday!").setDescription("Hadda xor baad tahay — sii wad ciyaarta!").setTimestamp()] });
  }
  if (f.hasKey) {
    await updateUser(u.discordId, { inJail: false, jailUntil: null, hasKey: false });
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.green).setTitle("🗝️  Furaha Xabsiga!")
      .setDescription("Furaha ayaad isticmaashay — **XORIYAD!** 🎉\n_(Furaha waa la isticmaalay, hadda gone)_")
      .setTimestamp()
    ] });
  }
  const BAIL = 50;
  if (f.money < BAIL) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ Lacag kuma filan bail!\nBail: **$${BAIL}** | Jeebka: **$${f.money}**`)], ephemeral: true });
  await updateUser(u.discordId, { money: f.money - BAIL, inJail: false, jailUntil: null });
  return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.green).setTitle("🔓  Bail La Bixiyay!")
    .setDescription("💰 $50 bail lacag ah waa la bixiyay — **XORIYAD!** 🎉")
    .addFields({ name: "💰 Jeebka haray", value: `\`\`\`$${f.money - BAIL}\`\`\``, inline: true })
    .setTimestamp()
  ] });
}

// ─── /duel ────────────────────────────────────────────────────────────────────
async function handleDuel(i: ChatInputCommandInteraction) {
  const u = await getOrCreateUser(i.user.id, i.user.username);
  await releaseIfExpired(u);
  const f = (await getUser(u.discordId))!;
  if (isJailed(f)) return i.reply({ embeds: [new EmbedBuilder().setColor(C.crimson).setDescription("🔒 **Xabsi baad ku jirtaa!** Tartam ma samayn kartid.")], ephemeral: true });
  const target = i.options.getUser("user", true);
  const lacag  = i.options.getInteger("lacag", true);
  if (target.id === i.user.id) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ Naftaada kama tartami kartid!")], ephemeral: true });
  if (lacag > f.money) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ Jeebka lacag kuma filan! Jeebka: **$${f.money}**`)], ephemeral: true });
  const t = await getUser(target.id);
  if (!t) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ **${target.username}** ciyaarta ma bilaabo!`)], ephemeral: true });
  if (lacag > t.money) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ **${target.username}** jeeb lacag kuma filan!`)], ephemeral: true });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("duel_yes").setLabel("⚔️ Aqbali").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("duel_no") .setLabel("🏃 Diid").setStyle(ButtonStyle.Danger),
  );
  const invite = new EmbedBuilder()
    .setColor(C.pink)
    .setTitle("⚔️  Duel Casuumaad!")
    .setDescription(
      `**${i.user.username}** wuxuu kugu casuumay duel 1vs1, **${target.username}**!\n\n` +
      "Aqbali ama diid hoos 👇"
    )
    .addFields({ name: "💰 Lacagta", value: `\`\`\`$${lacag}\`\`\``, inline: true })
    .setFooter({ text: "⏳ 30 ilbiriqsi gudahood ka jawaab!" })
    .setTimestamp();

  let dmMsg;
  try {
    dmMsg = await target.send({ embeds: [invite], components: [row] });
  } catch {
    return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ **${target.username}** DM wuu xiran yahay!`)], ephemeral: true });
  }

  await i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.green)
    .setTitle("✅  Duel Casuumaad La Diray!")
    .setDescription(`Waxaan **${target.username}** ugu diray DM duel 1vs1 ah.`)
    .setTimestamp()
  ], ephemeral: true });

  const collector = dmMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 30000 });
  collector.on("collect", async (btn) => {
    if (btn.user.id !== target.id) { await btn.reply({ content: "❌ Adiga kuma saabsana!", ephemeral: true }); return; }
    if (btn.customId === "duel_no") {
      const decline = new EmbedBuilder()
        .setColor(C.orange)
        .setTitle("🏃  Duel La Diidday!")
        .setDescription(`**${target.username}** wuu diiday duel-ka — geesinnimadu maanta ma aysan imaan.`)
        .setTimestamp();
      await btn.update({ embeds: [decline], components: [] });
      collector.stop(); return;
    }
    const winner = Math.random() < 0.5 ? i.user : target;
    const loser  = winner.id === i.user.id ? target : i.user;
    const wU = await getUser(winner.id);
    const lU = await getUser(loser.id);
    if (wU && lU) {
      await updateUser(winner.id, { money: wU.money + lacag, xp: wU.xp + 25 });
      await updateUser(loser.id,  { money: Math.max(0, lU.money - lacag) });
    }
    const done = new EmbedBuilder()
      .setColor(C.gold).setTitle("⚔️  DUEL DHAMMAADAY!")
      .setDescription(`🏆 **${winner.username}** waa kuu guulaystay!\n😢 **${loser.username}** waa la jabay!`)
      .addFields(
        { name: "💰 Lacagta Guulaha", value: `\`\`\`$${lacag}\`\`\``, inline: true },
        { name: "⭐ XP",              value: `\`\`\`+ 25\`\`\``,       inline: true },
      )
      .setTimestamp();
    await btn.update({ embeds: [done], components: [] });
    collector.stop();
  });
  collector.on("end", async (_, reason) => {
    if (reason === "time") {
      await i.editReply({ embeds: [new EmbedBuilder().setColor(C.dark).setTitle("⏰  Duel La Joojiyay!").setDescription(`**${target.username}** kama jawaabinin — waa la cararay!`)], components: [] });
    }
  });
}

// ─── /lottery ─────────────────────────────────────────────────────────────────
async function handleLottery(i: ChatInputCommandInteraction) {
  const u       = await getOrCreateUser(i.user.id, i.user.username);
  const tickets = i.options.getInteger("tickets", true);
  const cost    = tickets * 10;
  if (u.money < cost) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ Lacag kuma filan! Kharash: **$${cost}** | Jeebka: **$${u.money}**`)], ephemeral: true });
  await updateUser(u.discordId, { money: u.money - cost });
  const [lot] = await db.select().from(lotteryPool);
  if (!lot) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ Lottery-ga ma shaqaynayso!")], ephemeral: true });
  const cur      = (lot.tickets as Record<string, number>) ?? {};
  cur[u.discordId] = (cur[u.discordId] ?? 0) + tickets;
  const newPool  = lot.pool + cost;
  await db.update(lotteryPool).set({ pool: newPool, tickets: cur }).where(eq(lotteryPool.id, lot.id));
  const total    = Object.values(cur).reduce((a, b) => a + b, 0);
  if (total >= 20) {
    const entries: string[] = [];
    for (const [uid, cnt] of Object.entries(cur)) for (let k = 0; k < cnt; k++) entries.push(uid);
    const winId = entries[Math.floor(Math.random() * entries.length)]!;
    const winU  = await getUser(winId);
    if (winU) {
      await updateUser(winId, { money: winU.money + newPool });
      await db.update(lotteryPool).set({ pool: 0, tickets: {}, lastWinner: winId, lastDraw: new Date() }).where(eq(lotteryPool.id, lot.id));
      return i.reply({ embeds: [new EmbedBuilder()
        .setColor(C.gold).setTitle("🎰  JACKPOT! LOTTERY GUULAYSTE!")
        .setDescription(`🎉 <@${winId}> **$${newPool.toLocaleString()}** waa guulaystay!`)
        .addFields({ name: "🎫 Tikerradaada", value: `${tickets} ticket ($${cost})`, inline: true })
        .setTimestamp()
      ] });
    }
  }
  return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.purple).setTitle("🎫  Lottery Tickets La Iibsaday!")
    .addFields(
      { name: "🎟️ Tikerradaada",   value: `\`\`\`${tickets} ticket\`\`\``,         inline: true },
      { name: "💸 Kharash",         value: `\`\`\`$${cost}\`\`\``,                  inline: true },
      { name: "💰 Jeebka haray",    value: `\`\`\`$${u.money - cost}\`\`\``,        inline: true },
      { name: "🏆 Jackpot hadda",   value: `\`\`\`$${newPool.toLocaleString()}\`\`\``, inline: true },
      { name: "🎟️ Tikerrada guud", value: `\`\`\`${total}/20\`\`\``,               inline: true },
    ).setFooter({ text: "20 ticket marka la gaadhaa jackpot ayaa la qaadanayaa!" }).setTimestamp()
  ] });
}

// ─── /leaderboard ─────────────────────────────────────────────────────────────
async function handleLeaderboard(i: ChatInputCommandInteraction) {
  const users  = await db.select().from(discordUsers).orderBy(desc(sql`${discordUsers.money} + ${discordUsers.bank}`)).limit(10);
  const medals = ["🥇","🥈","🥉","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  const lines  = users.map((u, idx) =>
    `${medals[idx]} **${u.username}** — 💰 $${(u.money + u.bank).toLocaleString()}  _(Jeeb: $${u.money.toLocaleString()} | Bank: $${u.bank.toLocaleString()})_`
  );
  return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.gold).setTitle("🏆  Ugu Hodanta Ciyaartoyda")
    .setDescription(lines.join("\n") || "Ciyaartoy ma jiraan weli!")
    .setTimestamp()
  ] });
}

// ─── /status ──────────────────────────────────────────────────────────────────
async function handleStatus(i: ChatInputCommandInteraction) {
  const [playerCount] = await db.select({ count: count() }).from(discordUsers);
  const [jailedCount] = await db.select({ count: count() }).from(discordUsers).where(eq(discordUsers.inJail, true));
  const [richest]     = await db.select().from(discordUsers).orderBy(desc(sql`${discordUsers.money} + ${discordUsers.bank}`)).limit(1);
  const [totalMoney]  = await db.select({ total: sum(sql`${discordUsers.money} + ${discordUsers.bank}`) }).from(discordUsers);
  const [lobbyRow]    = await db.select().from(lobbyState);
  const [lotRow]      = await db.select().from(lotteryPool);
  const lobbyPlayers  = (lobbyRow?.players as string[] ?? []).length;
  return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.purple).setTitle("📊  Ciyaarta Xaaladdeeda Guud")
    .setDescription("Wax walba oo ciyaarta ka socda — si toos ah!")
    .addFields(
      { name: "👥 Ciyaartoyda Guud",  value: `\`\`\`${playerCount?.count ?? 0} qof\`\`\``,                 inline: true },
      { name: "🔒 Xabsiga Ku Jira",   value: `\`\`\`${jailedCount?.count ?? 0} qof\`\`\``,                 inline: true },
      { name: "💰 Lacagta Guud (DB)", value: `\`\`\`$${Number(totalMoney?.total ?? 0).toLocaleString()}\`\`\``, inline: true },
      { name: "🏆 Ugu Hodanaha",      value: richest ? `**${richest.username}** — $${(richest.money + richest.bank).toLocaleString()}` : "Cidna", inline: false },
      { name: "🎮 Lobby",             value: `\`\`\`${lobbyPlayers}/${LOBBY_MAX} — ${lobbyRow?.state === "active" ? "🟢 Socota" : "🟡 Sugaysa"}\`\`\``, inline: true },
      { name: "🎰 Lottery Jackpot",   value: `\`\`\`$${(lotRow?.pool ?? 0).toLocaleString()}\`\`\``,       inline: true },
    ).setFooter({ text: "🤖 Somali Battle Bot • Ciyaarta waa sii socota!" }).setTimestamp()
  ] });
}

// ─── /join ────────────────────────────────────────────────────────────────────
async function handleJoin(i: ChatInputCommandInteraction, client: Client) {
  const u = await getOrCreateUser(i.user.id, i.user.username);
  const [lot] = await db.select().from(lobbyState);
  if (!lot) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ Lobby ma jiro!")], ephemeral: true });
  const players = (lot.players as string[]) ?? [];
  if (players.includes(i.user.id)) return i.reply({ embeds: [new EmbedBuilder().setColor(C.orange).setDescription(`⚠️ **Horey ayaad lobby ku jirtaa!** Ciyaartoyda: **${players.length}/${LOBBY_MAX}**`)], ephemeral: true });
  if (lot.state === "active") return i.reply({ embeds: [new EmbedBuilder().setColor(C.orange).setDescription("🎮 **Ciyaartu horey u bilaabatay!** Kii xiga sugso.")], ephemeral: true });
  if (players.length >= LOBBY_MAX) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ **Lobby buuxday!** (${LOBBY_MAX}/${LOBBY_MAX})`)], ephemeral: true });

  players.push(i.user.id);
  await updateUser(u.discordId, { inLobby: true });
  await db.update(lobbyState).set({ players }).where(eq(lobbyState.id, lot.id));

  const bar      = "🟩".repeat(players.length) + "⬛".repeat(LOBBY_MAX - players.length);
  const canStart = players.length >= LOBBY_MIN;
  const note     = canStart ? `\n\n✅ **${players.length} qof jiraan — /lobby fur oo ciyaarta bilow!**` : "";
  return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.teal).setTitle("🚪  Lobby Ku Biirtay!")
    .setDescription(`${bar}\n**${players.length}/${LOBBY_MAX}** ciyaartoy${note}`)
    .addFields({ name: "⏳ Sugaysa", value: `**${LOBBY_MAX - players.length}** qof oo kale`, inline: true })
    .setTimestamp()
  ] });
}

// ─── /lobby ───────────────────────────────────────────────────────────────────
async function handleLobby(i: ChatInputCommandInteraction) {
  const [lot] = await db.select().from(lobbyState);
  if (!lot) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ Lobby ma jiro!")], ephemeral: true });
  const players    = (lot.players as string[]) ?? [];
  const bar        = "🟩".repeat(players.length) + "⬛".repeat(LOBBY_MAX - players.length);
  const playerList = players.length > 0 ? players.map(p => `<@${p}>`).join("  ") : "_(cidna)_";
  const canStart   = players.length >= LOBBY_MIN && lot.state !== "active";
  const embed = new EmbedBuilder()
    .setColor(lot.state === "active" ? C.green : C.gold)
    .setTitle("🎮  Lobby Xaaladda")
    .setDescription(`${bar}\n**${players.length}/${LOBBY_MAX}** ciyaartoy`)
    .addFields(
      { name: "📊 Xaaladda",    value: lot.state === "active" ? "🟢 Ciyaartu Socota" : "🟡 Sugaysa",   inline: true  },
      { name: "👥 Qofka Jira", value: `**${players.length}**`,                                           inline: true  },
      { name: "👤 Ciyaartoyda", value: playerList,                                                        inline: false },
    ).setTimestamp();
  if (canStart) embed.setFooter({ text: `✅ ${players.length} qof jiraan — hoosta dhoq "Ciyaarta Bilow"!` });
  const components = canStart ? [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("lobby_start").setLabel("🎮 Ciyaarta Bilow").setStyle(ButtonStyle.Success)
    )
  ] : [];
  return i.reply({ embeds: [embed], components });
}

// ─── /govbank ─────────────────────────────────────────────────────────────────
async function handleGovBank(i: ChatInputCommandInteraction) {
  const u   = await getOrCreateUser(i.user.id, i.user.username);
  const now = new Date();
  if (u.govBankLast) {
    const diff = now.getTime() - u.govBankLast.getTime();
    if (diff < 24 * 60 * 60 * 1000) {
      const left = 24 * 60 * 60 * 1000 - diff;
      const hrs  = Math.floor(left / 3600000);
      const mins = Math.floor((left % 3600000) / 60000);
      return i.reply({ embeds: [new EmbedBuilder().setColor(C.orange).setDescription(`⏳ Bank Dowlada waa la qaatay!\n**${hrs} saacadood ${mins} daqiiqo** ka dib ku soo noqo.`)], ephemeral: true });
    }
  }
  const amount = 300;
  await updateUser(u.discordId, { money: u.money + amount, govBankLast: now });
  return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.blue).setTitle("🏛️  Bank Dowlada")
    .setDescription(`✅ **$${amount}** ayaad ka heshay Bank Dowlada!\n\n💰 Lacagta cusub: **$${u.money + amount}**`)
    .addFields({ name: "⏳ Marka Xiga", value: "**24 saacadood**", inline: true })
    .setFooter({ text: "🏛️ Bank Dowlada — Maalin kasta hal mar" })
    .setTimestamp()
  ] });
}

// ─── /help ────────────────────────────────────────────────────────────────────
async function handleHelp(i: ChatInputCommandInteraction) {
  return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.purple)
    .setTitle("📖  Somali Battle — Amarrada Oo Dhan")
    .setDescription("Ciyaarta dhammaan amaradeeda sharaxaad leh 👇\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    .addFields(
      {
        name: "🎮  Bilowga & Xaaladda",
        value:
          "`/start` — Ciyaarta ku bilow, profile cusub sameyso (waxaad helaysaa $100 bilowga)\n" +
          "`/profile [@user]` — Xaaladda profile-gaaga eeg (lacag, HP, alaab, xabsi, doorka)\n" +
          "`/status` — Ciyaarta xaaladdeeda guud: ciyaartoy, jackpot, lobby, richest\n" +
          "`/help` — Amarrada oo dhan iyo sharaxaadooda",
        inline: false,
      },
      {
        name: "💰  Lacagta & Bangiga",
        value:
          "`/work` — Shaqo oo lacag kasoo qaado ($10–$60, waqti kasta isticmaal!)\n" +
          "`/daily` — Abaalmarinta maalinlaha qaado ($200 / $400 Booster, 24h mar)\n" +
          "`/bank deposit/withdraw/balance` — Bangiga maamul — lacag bangi ku kaydi ama soo bixi\n" +
          "`/transfer @user <lacag>` — Lacag qof kale u dir\n" +
          "`/leaderboard` — Ugu hodanta 10 ciyaartoyda eeg",
        inline: false,
      },
      {
        name: "🏪  Dukaanka",
        value:
          "`/shop` — Alaabta oo dhan iyo qiimaha iyo faa'iidooyinkooda eeg\n" +
          "`/buy <alaab>` — Alaab ka iibso:\n" +
          "  🔫 `qoryo` $500 — crime/robbank guul kordhis\n" +
          "  🖊️ `qalambi` $100 — +$15 shaqo kasta\n" +
          "  🤜 `gacan` $300 — steal guul kordhis (70%)\n" +
          "  🗝️ `furaha` $200 — xabsi 2 min (beddelkii 5min)\n" +
          "  🛡️ `gashaan` $400 — mar 1 rob/steal/arrest ka jooji\n" +
          "  💊 `cafimaad` $150 — HP +50 ku soo celi",
        inline: false,
      },
      {
        name: "⚔️  Dagaalka & Dembiga",
        value:
          "`/crime` — Dembi garaac (50% guul / 70% hub leh) — fashilku xabsi!\n" +
          "`/robbank @user` — 🏦💣 Bangiga qof kale xasuuq! Kharash: **$20,000** — 30–70% bangiga ka xadi kara\n" +
          "`/steal @user` — Lacag yar qof kale ka xad (50% / 70% gacan leh)\n" +
          "`/fright @user` — Cabsi rid qof kale oo lacag jeebkiisa ka daadi (60% guul)\n" +
          "`/duel @user <lacag>` — Tartam lacag leh — mid keliya ayaa guuleysta!",
        inline: false,
      },
      {
        name: "👮  Xabsiga",
        value:
          "`/arrest @user` — Qof kale xabsi geli (60% guul) — Gashaan iyo hasKey difaacaa\n" +
          "`/bail` — Xabsiga ka bixi: $50 bixin **ama** 🗝️ furaha xabsiga isticmaal (bilaash!)",
        inline: false,
      },
      {
        name: "🎰  Nasiibka",
        value:
          "`/lottery <tickets>` — Lottery ticket iibso (1–10 kasta, $10 kasta)\n" +
          "Marka **20 ticket** guud la gaadhaa, jackpot waa la qaadanayaa si toos ah!",
        inline: false,
      },
      {
        name: "🚪  Lobbyka & Doorashada",
        value:
          "`/join` — Lobby ku biir (9 qof buuxo marka ciyaartu bilaabataa)\n" +
          "`/lobby` — Lobby xaaladda hadda eeg — cidda ku jirta\n\n" +
          "Marka 9 qof la buuxo:\n" +
          "  ⚡ **2 Booster** si qarsoodi ah ayaa loo doortaa (DM ayay helayaan)\n" +
          "  👤 **7 Shacab** (DM ayay helayaan doorkooda)\n" +
          "  Booster = **2× lacag** shaqo & daily!",
        inline: false,
      },
      {
        name: "🏅  Heer System",
        value:
          "XP shaqo kasta waad helaysaa — heerkaagu si toos ah ayuu u kordhi doonaa!\n" +
          "🌱 L1→🥉 L2 (100xp)→🥈 L3 (300xp)→🥇 L4 (600xp)→💎 L5 (1000xp)\n" +
          "🔥 L6 (1500)→⚡ L7 (2200)→🌟 L8 (3200)→👑 L9 (4500)→🏆 L10 LEGEND (6000)\n" +
          "📬 **DM** ayaad u helaysaa markaad heer cusub gaadho!",
        inline: false,
      },
      {
        name: "🌐  Admin Amarrada",
        value:
          "`/resetlobby` — Lobby nadiifi (DM ayaa loo diraa ciyaartoyda)\n" +
          "`/servers` — Bot ku jiro servers-ka oo dhan database-ka ka eeg\n" +
          "`/vote @user` — Cod-saarid lobby ciyaartoyda",
        inline: false,
      },
      {
        name: "💡  Tilmaamo Muhiim ah",
        value:
          "• 🛡️ **Gashaan** wuxuu kaa difaacaa rob/steal/arrest — laakiin **mar keliya** ah!\n" +
          "• 🔫 **Qoryo** wuxuu u baahan yahay robbank kharashka ($20,000)\n" +
          "• 🏦 **Bangiga** ku kaydi lacagta si rob jeebka ka xadin u dhaafo\n" +
          "• ⚡ **Booster** door-saarka lobby ayuu ka yimaadaa — DM ayaad u helaysaa\n" +
          "• 🏅 **Level** kordhi shaqo iyo daily si aad ugu sareyso!",
        inline: false,
      },
    )
    .setFooter({ text: "🤖 Somali Battle Bot • /status ciyaarta xaaladda u eeg" })
    .setTimestamp()
  ] });
}


// ─── /gamble ──────────────────────────────────────────────────────────────────
async function handleGamble(i: ChatInputCommandInteraction) {
  const u     = await getOrCreateUser(i.user.id, i.user.username);
  const lacag = i.options.getInteger("lacag", true);

  if (lacag > u.money) return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.red)
    .setTitle("❌  Lacag Kuma Filan!")
    .setDescription(`Jeebka: **$${u.money}** — ciyaartu u baahan tahay **$${lacag}**`)
  ], ephemeral: true });

  const win      = Math.random() < 0.5;
  const newMoney = win ? u.money + lacag : u.money - lacag;
  await updateUser(u.discordId, { money: Math.max(0, newMoney), xp: u.xp + (win ? 10 : 0) });

  const winScenes = [
    { e: "🎰", t: "JACKPOT! Mishiinka ayaa tumay!" },
    { e: "🃏", t: "Kaadhkii ugu fiicnaa ayaad heshay!" },
    { e: "🎯", t: "Sahanka hore ayaad ku dhuftay!" },
    { e: "🎲", t: "Liiskii saxda ahaa ayaa soo baxay!" },
    { e: "🍀", t: "Nasiibku wuu kula jiraa maanta!" },
    { e: "💎", t: "Dhagaxaan qaaliga ah ayaad heshay!" },
  ];
  const loseScenes = [
    { e: "💸", t: "Lacagtii way dhacdeen!" },
    { e: "😭", t: "Nasiibku kuma jirin maanta!" },
    { e: "🔥", t: "Lacagtii waa la gubay!" },
    { e: "😤", t: "Dib u isku day — marwalba si fiican uma dhammaan!" },
    { e: "🌧️", t: "Roobka qasaaraha ah ayaa soo daatay!" },
    { e: "💀", t: "Lacagtii waxay taqtay meesha!" },
  ];

  const scene = win
    ? winScenes [Math.floor(Math.random() * winScenes.length)]!
    : loseScenes[Math.floor(Math.random() * loseScenes.length)]!;

  // Animated dice roll display
  const dice = ["⚀","⚁","⚂","⚃","⚄","⚅"];
  const d1   = dice[Math.floor(Math.random() * 6)]!;
  const d2   = dice[Math.floor(Math.random() * 6)]!;

  return i.reply({ embeds: [new EmbedBuilder()
    .setColor(win ? C.green : C.crimson)
    .setTitle(`${scene.e}  ${win ? "GUUL!" : "QASAARO!"}`)
    .setDescription(`${d1} ${d2}\n\n**${scene.t}**`)
    .addFields(
      { name: win ? "💵 Lacagta la helay" : "💸 Lacagta la lumiyay",
        value: `\`\`\`${win ? "+" : "-"} $${lacag}\`\`\``,          inline: true },
      { name: "💰 Jeebka hadda",
        value: `\`\`\`$${Math.max(0, newMoney)}\`\`\``,              inline: true },
      { name: "🎲 Isku day",
        value: `\`\`\`%50 / %50\`\`\``,                              inline: true },
    )
    .setFooter({ text: win ? "🍀 Nasiibkaagu waa weyn — sii ciyaar!" : "😤 Mar kale isku day — nasiibku wuu kuu soo jeedi doonaa!" })
    .setTimestamp()
  ] });
}

// ─── /vote ────────────────────────────────────────────────────────────────────
async function handleVote(i: ChatInputCommandInteraction) {
  const target   = i.options.getUser("user", true);
  const guildId  = i.guildId!;
  const VOTE_SEC = 30;

  if (target.id === i.user.id) return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.red).setDescription("❌ Naftaada ma codeyn kartid!")
  ], ephemeral: true });

  // Only one active vote per guild at a time
  if (activeVotes.has(guildId)) {
    const cur = activeVotes.get(guildId)!;
    return i.reply({ embeds: [new EmbedBuilder()
      .setColor(C.orange)
      .setTitle("⏳  Codayn Hore Ayaa Socota!")
      .setDescription(`Hada cod-saarista **${cur.targetName}** ayaa soconaysa.\nSugso waqtigeedu dhammaado.`)
    ], ephemeral: true });
  }

  // Target must be in lobby
  const [lot] = await db.select().from(lobbyState);
  const players = (lot?.players as string[] ?? []);
  if (!players.includes(target.id)) return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.red).setDescription(`❌ **${target.username}** lobby kuma jiro!`)
  ], ephemeral: true });

  // Voter must also be in lobby
  if (!players.includes(i.user.id)) return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.red).setDescription("❌ Adigu lobby kuma jirtid — ma codeyn kartid!")
  ], ephemeral: true });

  // Register vote session
  const session = { targetId: target.id, targetName: target.username, yes: new Set<string>(), no: new Set<string>() };
  session.yes.add(i.user.id); // starter's vote counts as YES
  activeVotes.set(guildId, session);

  const needed = Math.ceil(players.length / 2);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("vote_yes").setLabel("✅ Ha ka baxo").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("vote_no") .setLabel("❌ Ha jogo").setStyle(ButtonStyle.Secondary),
  );

  const makeEmbed = (yes: number, no: number, done = false, outcome = "", revealedRole = "") => {
    const roleLabel = revealedRole === "booster"
      ? "⚡ **BOOSTER** ayuu ahaa!"
      : revealedRole === "civilian"
        ? "👤 **Shacab** ayuu ahaa"
        : "";
    const roleColor = revealedRole === "booster" ? C.gold : revealedRole === "civilian" ? C.blue : C.crimson;
    return new EmbedBuilder()
      .setColor(done ? (outcome === "kicked" ? roleColor : C.green) : C.purple)
      .setTitle(done
        ? (outcome === "kicked" ? "🚪  Cod-saarista Guuleysatay!" : "🛡️  Cod-saarista Waa La Diidday!")
        : `🗳️  Cod-saaris: ${target.username}`)
      .setDescription(done
        ? (outcome === "kicked"
            ? `**${target.username}** lobby ayaa laga saaray — cod-badnaantu way go'aamisay! 👋\n\n🎭 **Doorka la ogaaday:** ${roleLabel}`
            : `**${target.username}** lobby ku haray — codda "Ha ka baxo" ma gaarin kulan-sare!`)
        : `<@${i.user.id}> waxay codsatay in **${target.username}** lobby laga saaro!\n\nCodee hoos — **${VOTE_SEC}** ilbiriqsi gudahood!`)
      .addFields(
        { name: "✅ Ha ka baxo", value: `\`\`\`${yes} cod\`\`\``,                                   inline: true },
        { name: "❌ Ha jogo",    value: `\`\`\`${no} cod\`\`\``,                                    inline: true },
        { name: "🎯 Ku filan",   value: `\`\`\`${needed} cod (guud: ${players.length})\`\`\``,     inline: true },
        ...(done && outcome === "kicked" && revealedRole
          ? [{ name: "🎭 Doorka Qarsoodi", value: revealedRole === "booster" ? "```⚡ BOOSTER```" : "```👤 Shacab```", inline: false }]
          : []),
      )
      .setFooter({ text: done ? "🔍 Doorka waa la ogaaday — ciyaartu waa socota!" : `⏳ ${VOTE_SEC} ilbiriqsi — lobby qofkii/qofkeedii oo kaliya!` })
      .setTimestamp();
  };

  const msg = await i.reply({ embeds: [makeEmbed(1, 0)], components: [row], fetchReply: true });

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: VOTE_SEC * 1000,
  });

  collector.on("collect", async (btn) => {
    const s = activeVotes.get(guildId);
    if (!s) { await btn.deferUpdate(); return; }

    // Must be a lobby member
    const curLot   = await db.select().from(lobbyState);
    const curPlayers = (curLot[0]?.players as string[] ?? []);
    if (!curPlayers.includes(btn.user.id)) {
      await btn.reply({ content: "❌ Lobby kuma jirtid — ma codeyn kartid!", ephemeral: true });
      return;
    }
    // Remove from both sets first (change vote)
    s.yes.delete(btn.user.id);
    s.no.delete(btn.user.id);
    if (btn.customId === "vote_yes") s.yes.add(btn.user.id);
    else                              s.no.add(btn.user.id);

    // Check early majority
    if (s.yes.size >= needed) {
      collector.stop("majority_yes");
    } else if (s.no.size >= needed) {
      collector.stop("majority_no");
    } else {
      await btn.update({ embeds: [makeEmbed(s.yes.size, s.no.size)], components: [row] });
    }
  });

  collector.on("end", async (_, reason) => {
    const s = activeVotes.get(guildId);
    activeVotes.delete(guildId);
    if (!s) return;

    const kicked = reason === "majority_yes" || (reason === "time" && s.yes.size > s.no.size);

    if (kicked) {
      // Fetch role BEFORE resetting so we can reveal it
      const targetUser = await getUser(s.targetId);
      const revealedRole = targetUser?.role ?? "civilian";

      // Remove from lobby
      const curLot     = await db.select().from(lobbyState);
      const curPlayers = (curLot[0]?.players as string[] ?? []).filter(p => p !== s.targetId);
      await db.update(lobbyState).set({ players: curPlayers, state: "waiting" }).where(eq(lobbyState.id, curLot[0]!.id));
      await updateUser(s.targetId, { inLobby: false, role: "civilian" });
      await i.editReply({ embeds: [makeEmbed(s.yes.size, s.no.size, true, "kicked", revealedRole)], components: [] });
    } else {
      await i.editReply({ embeds: [makeEmbed(s.yes.size, s.no.size, true, "stayed")], components: [] });
    }
  });
}

// ─── /resetlobby ──────────────────────────────────────────────────────────────
async function handleResetLobby(i: ChatInputCommandInteraction) {
  const [lot] = await db.select().from(lobbyState);
  if (!lot) return i.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ Lobby ma jiro!")], ephemeral: true });

  const players = (lot.players as string[]) ?? [];

  // DM each player before resetting
  if (players.length > 0 && botClient) {
    const dmEmbed = new EmbedBuilder()
      .setColor(C.orange)
      .setTitle("🔄  Lobby Dib Ayaa Loo Bilaabay!")
      .setDescription(
        "⚠️ **Admin-ka wuxuu xidhmiyay lobby-ga hadda!**\n\n" +
        "Ciyaartii waa la joojiyay — lobby cusub waa diyaar.\n\n" +
        "**Waxa aad samayn kartid:**\n" +
        "• 🚪 `/join` — Lobby cusub ku biir\n" +
        "• 💼 `/work` — Shaqo oo lacag kasoo qaado\n" +
        "• 🎁 `/daily` — Abaalmarintaada qaado\n\n" +
        "_Guul iyo barwaaqo ciyaarka cusub!_ ⚔️"
      )
      .setFooter({ text: "🤖 Somali Battle Bot" })
      .setTimestamp();

    for (const pid of players) {
      try {
        const dUser = await botClient.users.fetch(pid);
        await dUser.send({ embeds: [dmEmbed] });
      } catch { /* DMs disabled — skip */ }
    }
  }

  // Reset all players' roles and lobby status
  if (players.length > 0) {
    for (const pid of players) {
      await updateUser(pid, { role: "civilian", inLobby: false });
    }
  }

  // Reset every player's inLobby flag (catch anyone not in the array)
  await db.update(discordUsers).set({ inLobby: false, role: "civilian" });

  // Clear the lobby
  await db.update(lobbyState).set({ players: [], state: "waiting", startedAt: null }).where(eq(lobbyState.id, lot.id));

  const hadPlayers = players.length;
  const embed = new EmbedBuilder()
    .setColor(C.teal)
    .setTitle("🔄  Lobby Dib Ayaa Loo Bilaabay!")
    .setDescription(
      `Ciyaartii hore waa la tirtiray ✅\n` +
      `**${hadPlayers}** qof ayaa lobby ka saaray.\n\n` +
      "Lobby cusub waa diyaar — qof kasta `/join` isticmaalo si uu ku biiro!"
    )
    .addFields(
      { name: "📊 Xaaladda cusub", value: `\`\`\`🟡 Sugaysa  0/${LOBBY_MAX}\`\`\``, inline: true },
      { name: "🔄 La tirtiray",    value: `\`\`\`${hadPlayers} qof\`\`\``,           inline: true },
    )
    .setFooter({ text: "🤖 Ciyaar cusub — /join ku biir!" })
    .setTimestamp();

  return i.reply({ embeds: [embed] });
}

// ─── /caawi ───────────────────────────────────────────────────────────────────
async function handleCaawi(i: ChatInputCommandInteraction) {
  const fariin = i.options.getString("fariin", true);

  await db.insert(supportMessages).values({
    discordId: i.user.id,
    username:  i.user.username,
    message:   fariin,
  });

  // Confirm to user (ephemeral — private)
  return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.teal)
    .setTitle("📩  Fariintii Waa La Helay!")
    .setDescription(
      "Fariintaada si ammaan ah ayaa loo keenay. Waxaa lagugu soo jawaabi doonaa sida ugu dhakhsaha badan! 🙏\n\n" +
      "**Fariintaada:**\n" +
      `> ${fariin}`
    )
    .setFooter({ text: "🤖 Somali Battle Support — Mahadsanid!" })
    .setTimestamp()
  ], ephemeral: true });
}


// ─── /servers ─────────────────────────────────────────────────────────────────
async function handleServers(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  const guilds = await db
    .select()
    .from(guildRegistry)
    .orderBy(desc(guildRegistry.joinedAt));

  const active   = guilds.filter(g => g.active);
  const inactive = guilds.filter(g => !g.active);

  const embed = new EmbedBuilder()
    .setColor(C.teal)
    .setTitle(`🌐  Bot Servers — ${active.length} Active | ${inactive.length} Left`)
    .setDescription("Database-ka ka helay server-yada bot ku jiro iyo ka tagay:\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    .setTimestamp();

  if (active.length > 0) {
    const lines = active.slice(0, 15).map((g, idx) => {
      const date = g.joinedAt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
      return `\`${idx + 1}.\` 🟢 **${g.guildName}** — _${date}_`;
    }).join("\n");
    embed.addFields({ name: `✅ Active Servers (${active.length})`, value: lines, inline: false });
  }

  if (inactive.length > 0) {
    const lines = inactive.slice(0, 10).map((g, idx) => {
      const date = g.leftAt ? g.leftAt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "?";
      return `\`${idx + 1}.\` 🔴 **${g.guildName}** — ka tegay ${date}`;
    }).join("\n");
    embed.addFields({ name: `❌ Ka Tagay (${inactive.length})`, value: lines, inline: false });
  }

  if (guilds.length === 0) {
    embed.setDescription("📭 Wali server ma jiraan database-ka.");
  }

  embed.setFooter({ text: `📊 Wadarta: ${guilds.length} server • Active: ${active.length}` });
  return i.editReply({ embeds: [embed] });
}

// ─── /ban ─────────────────────────────────────────────────────────────────────
async function handleBan(i: ChatInputCommandInteraction) {
  return i.reply({ embeds: [new EmbedBuilder()
    .setColor(C.dark).setTitle("🚫  Admin Command")
    .setDescription("Admin amarrada bot dhexdiisa lama isticmaalo.\n📊 **Replit Database** isticmaal si aad u maamusho isticmaalayaasha.")
  ], ephemeral: true });
}

// ─── Bot Start ─────────────────────────────────────────────────────────────────
export async function startBot() {
  await ensureLobby();
  await ensureLottery();
  await registerCommands();

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  botClient = client;

  client.once("clientReady", async (readyClient) => {
    logger.info(`🤖 Discord bot online: ${readyClient.user.tag}`);
    readyClient.user.setActivity("⚔️ Somali Battle | /help", { type: 0 });
    // Sync all current guilds into registry
    for (const guild of readyClient.guilds.cache.values()) {
      await db.insert(guildRegistry)
        .values({ guildId: guild.id, guildName: guild.name, active: true })
        .onConflictDoUpdate({ target: guildRegistry.guildId, set: { guildName: guild.name, active: true, leftAt: null } });
    }
    logger.info(`📋 Guild registry synced: ${readyClient.guilds.cache.size} servers`);
  });

  // Track new guilds
  client.on("guildCreate", async (guild) => {
    logger.info(`➕ Bot joined guild: ${guild.name} (${guild.id})`);
    await db.insert(guildRegistry)
      .values({ guildId: guild.id, guildName: guild.name, active: true })
      .onConflictDoUpdate({ target: guildRegistry.guildId, set: { guildName: guild.name, active: true, leftAt: null } });
  });

  // Track removed guilds
  client.on("guildDelete", async (guild) => {
    logger.info(`➖ Bot left guild: ${guild.name} (${guild.id})`);
    await db.update(guildRegistry)
      .set({ active: false, leftAt: new Date() })
      .where(eq(guildRegistry.guildId, guild.id));
  });

  client.on("interactionCreate", async (interaction) => {
    if (interaction.isButton() && interaction.customId === "lobby_start") {
      try {
        const [lot] = await db.select().from(lobbyState);
        if (!lot) { await interaction.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ Lobby ma jiro!")], ephemeral: true }); return; }
        const players = (lot.players as string[]) ?? [];
        if (lot.state === "active") { await interaction.reply({ embeds: [new EmbedBuilder().setColor(C.orange).setDescription("🎮 Ciyaartu horey u bilaabatay!")], ephemeral: true }); return; }
        if (players.length < LOBBY_MIN) { await interaction.reply({ embeds: [new EmbedBuilder().setColor(C.red).setDescription(`❌ Ugu yaraan **${LOBBY_MIN} qof** ayaa loo baahan yahay! Hadda: **${players.length}**`)], ephemeral: true }); return; }
        const shuffled = [...players].sort(() => Math.random() - 0.5);
        const boosters = shuffled.slice(0, BOOSTER_COUNT);
        for (const pid of players) {
          const role = boosters.includes(pid) ? "booster" : "civilian";
          await updateUser(pid, { role });
          await sendRoleDM(client, pid, role);
        }
        await db.update(lobbyState).set({ players, state: "active", startedAt: new Date() }).where(eq(lobbyState.id, lot.id));
        await interaction.update({ embeds: [new EmbedBuilder()
          .setColor(C.gold).setTitle("🎮  LOBBY BILAABATAY!")
          .setDescription(`**${players.length} qof** oo dhammu way ku biirteen!\n\n⚡ **${BOOSTER_COUNT} Booster** si qarsoodi ah ayaa loo doortay!\n👤 **${players.length - BOOSTER_COUNT} Shacab**\n\n_📬 Qof walba DM ayuu u helay doorkooda!_ 🤫\n\n**🚀 ${interaction.user.username}** ayaa lobby-ga bilaabay!`)
          .setTimestamp()
        ], components: [] });
      } catch (err) {
        logger.error({ err }, "lobby_start button error");
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    try {
      const n = interaction.commandName;
      if      (n === "start")       await handleStart(interaction);
      else if (n === "profile")     await handleProfile(interaction);
      else if (n === "work")        await handleWork(interaction);
      else if (n === "daily")       await handleDaily(interaction);
      else if (n === "bank")        await handleBank(interaction);
      else if (n === "transfer")    await handleTransfer(interaction);
      else if (n === "shop")        await handleShop(interaction);
      else if (n === "buy")         await handleBuy(interaction);
      else if (n === "crime")       await handleCrime(interaction);
      else if (n === "robbank")     await handleRobBank(interaction);
      else if (n === "steal")       await handleSteal(interaction);
      else if (n === "fright")      await handleFright(interaction);
      else if (n === "arrest")      await handleArrest(interaction);
      else if (n === "bail")        await handleBail(interaction);
      else if (n === "duel")        await handleDuel(interaction);
      else if (n === "lottery")     await handleLottery(interaction);
      else if (n === "leaderboard") await handleLeaderboard(interaction);
      else if (n === "status")      await handleStatus(interaction);
      else if (n === "join")        await handleJoin(interaction, client);
      else if (n === "lobby")       await handleLobby(interaction);
      else if (n === "help")        await handleHelp(interaction);
      else if (n === "gamble")      await handleGamble(interaction);
      else if (n === "vote")        await handleVote(interaction);
      else if (n === "resetlobby")  await handleResetLobby(interaction);
      else if (n === "caawi")       await handleCaawi(interaction);
      else if (n === "servers")     await handleServers(interaction);
      else if (n === "ban")         await handleBan(interaction);
      else if (n === "govbank")     await handleGovBank(interaction);
    } catch (err) {
      logger.error({ err, cmd: interaction.commandName }, "Command error");
      const msg = { embeds: [new EmbedBuilder().setColor(C.red).setDescription("❌ **Khalad ayaa dhacay!** Dib u isku day.")], ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    }
  });

  await client.login(TOKEN);
}
