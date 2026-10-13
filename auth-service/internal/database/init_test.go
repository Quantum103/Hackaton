package database

import (
	"database/sql"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

type legacyAdminFixture struct {
	name     string
	email    string
	password string
}

type legacyUserFixture struct {
	login    string
	password string
}

func createLegacyDatabase(t *testing.T, admins []legacyAdminFixture, users []legacyUserFixture) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open legacy DB: %v", err)
	}
	if _, err := db.Exec(`
		CREATE TABLE admins (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			email TEXT UNIQUE NOT NULL,
			password TEXT NOT NULL
		);
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			login TEXT UNIQUE NOT NULL,
			password TEXT NOT NULL
		);
	`); err != nil {
		db.Close()
		t.Fatalf("create legacy schema: %v", err)
	}
	for _, item := range admins {
		if _, err := db.Exec(
			"INSERT INTO admins(name,email,password) VALUES(?,?,?)",
			item.name, item.email, item.password,
		); err != nil {
			db.Close()
			t.Fatalf("insert legacy administrator: %v", err)
		}
	}
	for _, item := range users {
		if _, err := db.Exec(
			"INSERT INTO users(login,password) VALUES(?,?)",
			item.login, item.password,
		); err != nil {
			db.Close()
			t.Fatalf("insert legacy user: %v", err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close legacy DB: %v", err)
	}
	return path
}

func passwordHash(t *testing.T, password string) string {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("hash test password: %v", err)
	}
	return string(hash)
}

func TestInitDoesNotMigrateKnownDefaultAdminCredential(t *testing.T) {
	path := createLegacyDatabase(t,
		[]legacyAdminFixture{
			{name: "Super Admin", email: "admin@gmail.com", password: passwordHash(t, "admin123")},
		},
		[]legacyUserFixture{
			{login: "staff@example.test", password: passwordHash(t, "staff-pass-123")},
		},
	)

	db, err := Init(path)
	if err != nil {
		t.Fatalf("initialize migrated DB: %v", err)
	}
	defer db.Close()

	var admins, viewers, total int
	if err := db.QueryRow("SELECT COUNT(*) FROM accounts WHERE role='admin'").Scan(&admins); err != nil {
		t.Fatalf("count administrators: %v", err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM accounts WHERE role='viewer'").Scan(&viewers); err != nil {
		t.Fatalf("count viewers: %v", err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM accounts").Scan(&total); err != nil {
		t.Fatalf("count accounts: %v", err)
	}
	if admins != 0 {
		t.Fatalf("known default account should not become an administrator; got %d admins", admins)
	}
	if viewers != 1 || total != 1 {
		t.Fatalf("legacy staff should be preserved as viewer; got viewers=%d total=%d", viewers, total)
	}
}

func TestInitMigratesExistingNonDefaultAdministrator(t *testing.T) {
	hash := passwordHash(t, "a-strong-admin-password")
	path := createLegacyDatabase(t,
		[]legacyAdminFixture{
			{name: "Restaurant Owner", email: "owner@example.test", password: hash},
		},
		nil,
	)

	db, err := Init(path)
	if err != nil {
		t.Fatalf("initialize migrated DB: %v", err)
	}
	defer db.Close()

	var name, email, storedHash, role string
	if err := db.QueryRow(
		"SELECT name,email,password_hash,role FROM accounts WHERE email=?",
		"owner@example.test",
	).Scan(&name, &email, &storedHash, &role); err != nil {
		t.Fatalf("read migrated administrator: %v", err)
	}
	if name != "Restaurant Owner" || email != "owner@example.test" || role != "admin" || storedHash != hash {
		t.Fatalf("unexpected migrated administrator: name=%q email=%q role=%q", name, email, role)
	}
}
