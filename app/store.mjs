import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
const derive = promisify(scrypt),
  hash = (s) => createHash("sha256").update(s).digest("hex");
export class Accounts {
  constructor(root) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    this.db = new DatabaseSync(path.join(root, "accounts.sqlite"));
    chmodSync(path.join(root, "accounts.sqlite"), 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,salt TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,user_id TEXT UNIQUE NOT NULL REFERENCES users(id),name TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'new',snapshot TEXT,job TEXT,job_result TEXT,error TEXT,automation INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(digest TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(subject TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);`);
    if (
      !this.db
        .prepare("PRAGMA table_info(users)")
        .all()
        .some((c) => c.name === "role")
    ) {
      this.db.exec(
        "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'",
      );
    }
    this.db
      .prepare("UPDATE workspaces SET state='queued' WHERE state='running'")
      .run();
  }
  rate(subject, max, seconds = 60) {
    const now = Date.now(),
      row = this.db
        .prepare("SELECT * FROM attempts WHERE subject=?")
        .get(subject);
    if (!row || now - row.window > seconds * 1000) {
      this.db
        .prepare(
          "INSERT INTO attempts VALUES(?,?,1) ON CONFLICT(subject) DO UPDATE SET window=excluded.window,count=1",
        )
        .run(subject, now);
      return true;
    }
    if (row.count >= max) return false;
    this.db
      .prepare("UPDATE attempts SET count=count+1 WHERE subject=?")
      .run(subject);
    return true;
  }
  async register(username, password, maxAccounts = 50, role = "owner") {
    username =
      typeof username === "string" ? username.toLowerCase().trim() : "";
    if (username === "judge" && role !== "reviewer")
      throw new Error("That username is reserved for review access.");
    if (!["owner", "reviewer"].includes(role))
      throw new Error("Invalid account role");
    if (!/^[a-z][a-z0-9_-]{2,31}$/.test(username))
      throw new Error(
        "Use 3-32 letters, numbers, underscores or hyphens for your username.",
      );
    if (
      typeof password !== "string" ||
      password.length < 12 ||
      password.length > 128
    )
      throw new Error("Use a password between 12 and 128 characters.");
    if (this.db.prepare("SELECT count(*) n FROM users").get().n >= maxAccounts)
      throw new Error("Registration is currently full.");
    const salt = randomBytes(32).toString("hex");
    const digest = await derive(password, salt, 64, {
      N: 131072,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    });
    const id = randomBytes(16).toString("hex"),
      workspace = randomBytes(16).toString("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.db.prepare("SELECT count(*) n FROM users").get().n >= maxAccounts
      )
        throw new Error("Registration is currently full.");
      this.db
        .prepare(
          "INSERT INTO users(id,username,password_hash,salt,created_at,role) VALUES(?,?,?,?,?,?)",
        )
        .run(id, username, digest.toString("hex"), salt, Date.now(), role);
      this.db
        .prepare(
          "INSERT INTO workspaces(id,user_id,name,updated_at) VALUES(?,?,?,?)",
        )
        .run(workspace, id, `${username}'s workspace`, Date.now());
      this.db.exec("COMMIT");
    } catch {
      this.db.exec("ROLLBACK");
      throw new Error("That username is unavailable.");
    }
    return { id, username, role };
  }
  async ensureReviewer(access) {
    const user = this.db
      .prepare("SELECT id,role FROM users WHERE username=?")
      .get(access.username);
    if (user) {
      if (user.role !== "reviewer")
        throw new Error("Review username is already owned by another account");
      return;
    }
    await this.register(
      access.username,
      access.password,
      Number.MAX_SAFE_INTEGER,
      "reviewer",
    );
  }
  async login(username, password) {
    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      password.length > 128
    )
      return null;
    const user = this.db
      .prepare("SELECT * FROM users WHERE username=?")
      .get(username.toLowerCase().trim());
    const digest = await derive(password, user?.salt || "0".repeat(64), 64, {
      N: 131072,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    });
    if (
      !user ||
      !timingSafeEqual(digest, Buffer.from(user.password_hash, "hex"))
    )
      return null;
    return { id: user.id, username: user.username, role: user.role };
  }
  session(userId) {
    const token = randomBytes(32).toString("hex");
    this.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(hash(token), userId, Date.now() + 8 * 3600000);
    return token;
  }
  user(token) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    return (
      this.db
        .prepare(
          "SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.digest=? AND s.expires>?",
        )
        .get(hash(token), Date.now()) || null
    );
  }
  logout(token) {
    if (token)
      this.db.prepare("DELETE FROM sessions WHERE digest=?").run(hash(token));
  }
  workspace(userId) {
    const row = this.db
      .prepare("SELECT * FROM workspaces WHERE user_id=?")
      .get(userId);
    if (!row) throw new Error("Workspace not found");
    return {
      ...row,
      snapshot: row.snapshot ? JSON.parse(row.snapshot) : null,
      job_result: row.job_result ? JSON.parse(row.job_result) : null,
    };
  }
  enqueue(userId, action) {
    const row = this.workspace(userId);
    if (["queued", "running"].includes(row.state)) return false;
    this.db
      .prepare(
        "UPDATE workspaces SET state='queued',job=?,job_result=NULL,error=NULL,updated_at=? WHERE user_id=?",
      )
      .run(JSON.stringify(action), Date.now(), userId);
    return true;
  }
  next() {
    return this.db
      .prepare(
        "SELECT w.*,u.username FROM workspaces w JOIN users u ON w.user_id=u.id WHERE w.state='queued' ORDER BY w.updated_at LIMIT 1",
      )
      .get();
  }
  running(id) {
    this.db
      .prepare("UPDATE workspaces SET state='running',updated_at=? WHERE id=?")
      .run(Date.now(), id);
  }
  finish(id, result, action) {
    const snapshot = result?.ready ? JSON.stringify(result) : null;
    const automation =
      action.op === "approve" ? 1 : action.op === "cancel" ? 0 : null;
    this.db
      .prepare(
        "UPDATE workspaces SET state='ready',snapshot=COALESCE(?,snapshot),job_result=?,job=NULL,error=NULL,automation=COALESCE(?,automation),updated_at=? WHERE id=?",
      )
      .run(snapshot, JSON.stringify(result), automation, Date.now(), id);
  }
  fail(id, error) {
    this.db
      .prepare(
        "UPDATE workspaces SET state='error',error=?,job=NULL,updated_at=? WHERE id=?",
      )
      .run(error, Date.now(), id);
  }
  retry(id, error) {
    this.db
      .prepare(
        "UPDATE workspaces SET state='queued',error=?,updated_at=? WHERE id=?",
      )
      .run(error, Date.now(), id);
  }
  scheduled() {
    return this.db
      .prepare(
        "SELECT * FROM workspaces WHERE (automation=1 OR json_extract(job_result,'$.pending_funding') IS NOT NULL) AND state NOT IN ('queued','running') AND updated_at<?",
      )
      .all(Date.now() - 30000);
  }
  close() {
    this.db.close();
  }
}
