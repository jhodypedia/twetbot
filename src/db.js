import { Sequelize, DataTypes } from "sequelize";
import dotenv from "dotenv";
dotenv.config();

const {
  DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME
} = process.env;

export const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASS, {
  host: DB_HOST,
  port: DB_PORT,
  dialect: "mysql",
  logging: false
});

export const User = sequelize.define("User", {
  x_user_id: { type: DataTypes.STRING, allowNull: false, unique: true },
  username: { type: DataTypes.STRING, allowNull: false },
  name: { type: DataTypes.STRING },
  access_token: { type: DataTypes.TEXT, allowNull: false },
  refresh_token: { type: DataTypes.TEXT },
  token_type: { type: DataTypes.STRING },
  scope: { type: DataTypes.STRING },
  expires_at: { type: DataTypes.DATE },
  role: { type: DataTypes.ENUM("user","admin"), defaultValue: "user" }
}, { tableName: "users" });

export const Log = sequelize.define("Log", {
  username: { type: DataTypes.STRING },
  action: { type: DataTypes.STRING }, // like, retweet, reply, refresh, error
  tweet_id: { type: DataTypes.STRING },
  status: { type: DataTypes.STRING }, // ok / fail
  note: { type: DataTypes.TEXT }
}, { tableName: "logs" });

export const Setting = sequelize.define("Setting", {
  key: { type: DataTypes.STRING, primaryKey: true },
  value: { type: DataTypes.STRING }
}, { tableName: "settings" });

export async function initDb() {
  await sequelize.authenticate();
  await sequelize.sync();
  // default delay
  await Setting.findOrCreate({ where: { key: "broadcast_delay_sec" }, defaults: { value: "30" } });
}
