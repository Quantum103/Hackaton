package database

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

// Init prepares the SQLite schema. Existing legacy auth tables are kept so an old
// local database can be migrated without losing its administrator accounts.
func Init(dbPath string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	if _, err := db.Exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;"); err != nil {
		db.Close()
		return nil, fmt.Errorf("configure sqlite: %w", err)
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("connect sqlite database: %w", err)
	}

	schema := "CREATE TABLE IF NOT EXISTS admins (" +
		"id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL);" +
		"CREATE TABLE IF NOT EXISTS users (" +
		"id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT UNIQUE NOT NULL, password TEXT NOT NULL);" +
		"CREATE TABLE IF NOT EXISTS accounts (" +
		"id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, " +
		"password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','viewer')), created_at TEXT NOT NULL);" +
		"CREATE TABLE IF NOT EXISTS auth_sessions (" +
		"jti TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, " +
		"expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);" +
		"CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active ON auth_sessions(user_id, revoked, expires_at);" +
		"CREATE INDEX IF NOT EXISTS idx_accounts_role ON accounts(role);" +
		"CREATE TABLE IF NOT EXISTS products (" +
		"id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, norm_name TEXT NOT NULL UNIQUE, " +
		"unit TEXT NOT NULL CHECK(unit IN ('g','ml','pcs')));" +
		"CREATE TABLE IF NOT EXISTS supplies (" +
		"id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);" +
		"CREATE TABLE IF NOT EXISTS batches (" +
		"id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id), " +
		"supply_id INTEGER NOT NULL REFERENCES supplies(id) ON DELETE CASCADE, qty_initial INTEGER NOT NULL, " +
		"qty_remaining INTEGER NOT NULL, written_off INTEGER NOT NULL DEFAULT 0, received_at TEXT NOT NULL, " +
		"expires_at TEXT NOT NULL, last_status TEXT NOT NULL DEFAULT 'ok');" +
		"CREATE INDEX IF NOT EXISTS idx_batches_product_expiry ON batches(product_id, expires_at, id);" +
		"CREATE INDEX IF NOT EXISTS idx_batches_supply ON batches(supply_id);" +
		"CREATE TABLE IF NOT EXISTS dishes (" +
		"id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, stopped_since TEXT NULL);" +
		"CREATE TABLE IF NOT EXISTS dish_ingredients (" +
		"dish_id INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE, " +
		"product_id INTEGER NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL CHECK(quantity > 0), " +
		"PRIMARY KEY(dish_id, product_id));" +
		"CREATE TABLE IF NOT EXISTS orders (" +
		"id INTEGER PRIMARY KEY AUTOINCREMENT, order_number INTEGER NOT NULL UNIQUE, created_at TEXT NOT NULL, " +
		"status TEXT NOT NULL CHECK(status IN ('accepted','rejected')), shortages_json TEXT NOT NULL DEFAULT '[]');" +
		"CREATE TABLE IF NOT EXISTS order_items (" +
		"id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, " +
		"dish_id TEXT NOT NULL, name TEXT NOT NULL, portions INTEGER NOT NULL);" +
		"CREATE TABLE IF NOT EXISTS order_writeoffs (" +
		"id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, " +
		"product_id TEXT NOT NULL, product_name TEXT NOT NULL, unit TEXT NOT NULL, batch_id TEXT NOT NULL, " +
		"supply_number TEXT NOT NULL, expires_at TEXT NOT NULL, quantity INTEGER NOT NULL);" +
		"CREATE TABLE IF NOT EXISTS alerts (" +
		"id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL, text TEXT NOT NULL);" +
		"CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
		"CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);" +
		"CREATE INDEX IF NOT EXISTS idx_alerts_at ON alerts(at DESC);"

	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("create sqlite schema: %w", err)
	}

	// Migrate real administrator accounts from the older application. Its historical
	// startup routine seeded the public, well-known admin@gmail.com / admin123 account.
	// Do not carry that default credential into the new auth system: on an old volume
	// with no real administrator, the one-time admin setup screen must become available.
	type legacyAdmin struct {
		name     string
		email    string
		password string
	}
	legacyRows, err := db.Query("SELECT name,email,password FROM admins WHERE email IS NOT NULL AND password IS NOT NULL")
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("read legacy administrators: %w", err)
	}
	legacyAdmins := make([]legacyAdmin, 0)
	for legacyRows.Next() {
		var item legacyAdmin
		if err := legacyRows.Scan(&item.name, &item.email, &item.password); err != nil {
			legacyRows.Close()
			db.Close()
			return nil, fmt.Errorf("read legacy administrator: %w", err)
		}
		legacyAdmins = append(legacyAdmins, item)
	}
	if err := legacyRows.Err(); err != nil {
		legacyRows.Close()
		db.Close()
		return nil, fmt.Errorf("read legacy administrators: %w", err)
	}
	legacyRows.Close()

	createdAt := time.Now().UTC().Format(time.RFC3339Nano)
	for _, admin := range legacyAdmins {
		isKnownDefault := strings.EqualFold(strings.TrimSpace(admin.email), "admin@gmail.com") &&
			bcrypt.CompareHashAndPassword([]byte(admin.password), []byte("admin123")) == nil
		if isKnownDefault {
			continue
		}
		if _, err := db.Exec(
			"INSERT OR IGNORE INTO accounts(name,email,password_hash,role,created_at) VALUES(?,?,?,'admin',?)",
			strings.TrimSpace(admin.name), strings.ToLower(strings.TrimSpace(admin.email)), admin.password, createdAt,
		); err != nil {
			db.Close()
			return nil, fmt.Errorf("migrate legacy administrator: %w", err)
		}
	}

	// Keep legacy staff accounts too. Old user records already store bcrypt password
	// hashes; their login value is retained as the email/login identifier.
	if _, err := db.Exec(
		"INSERT OR IGNORE INTO accounts(name, email, password_hash, role, created_at) " +
			"SELECT login, lower(login), password, 'viewer', ? FROM users " +
			"WHERE login IS NOT NULL AND trim(login) <> '' AND password IS NOT NULL",
		time.Now().UTC().Format(time.RFC3339Nano),
	); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate legacy users: %w", err)
	}

	// Old revoked/expired tokens never need to remain in the sessions table.
	if _, err := db.Exec("DELETE FROM auth_sessions WHERE revoked <> 0 OR expires_at <= ?", time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		db.Close()
		return nil, fmt.Errorf("cleanup expired sessions: %w", err)
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err = db.Exec(
		"INSERT OR IGNORE INTO app_meta(key,value) VALUES " +
			"('revision','1'),('clock_speed','1'),('clock_base_real',?),('clock_base_sim',?)",
		now, now,
	)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize app state: %w", err)
	}

	return db, nil
}
