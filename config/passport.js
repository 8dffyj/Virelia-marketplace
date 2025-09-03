const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const pool = require("./db");
require("dotenv").config();

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
  done(null, rows[0]);
});

passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_REDIRECT_URI,
  scope: ["identify", "email", "guilds.join"]
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [profile.id]);

    if (rows.length === 0) {
      await pool.query(
        "INSERT INTO users (id, username, avatar, email) VALUES (?, ?, ?, ?)",
        [profile.id, profile.username, profile.avatar, profile.email]
      );
    } else {
      await pool.query(
        "UPDATE users SET username=?, avatar=?, email=? WHERE id=?",
        [profile.username, profile.avatar, profile.email, profile.id]
      );
    }

    // Auto-join guild if not a member
    const axios = require("axios");
    await axios.put(
      `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${profile.id}`,
      { access_token: accessToken },
      { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } }
    ).catch(() => {});

    return done(null, profile);
  } catch (err) {
    return done(err, null);
  }
}));

module.exports = passport;
